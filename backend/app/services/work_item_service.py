"""Work Item service — PostgreSQL + Redis + SLA + comments."""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update
from sqlalchemy.orm import selectinload

from app.db.postgres import WorkItem, RCARecord, Comment, User
from app.db import cache
from app.models.schemas import (
    WorkItemCreate, WorkItemResponse, RCASubmit, RCAResponse,
    CommentCreate, CommentResponse, MTTRStats, SLAStats
)
from app.services.state_machine import validate_transition, InvalidTransitionError

logger = logging.getLogger("ims.work_item")

# SLA deadlines by priority (minutes to acknowledge)
SLA_MINUTES = {"P0": 15, "P1": 60, "P2": 240, "P3": 1440}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _wi_to_response(wi: WorkItem) -> WorkItemResponse:
    now = _now()
    sla_breached = bool(wi.sla_deadline and wi.status not in ("RESOLVED", "CLOSED") and now > wi.sla_deadline)
    return WorkItemResponse(
        id=wi.id,
        component=wi.component,
        priority=wi.priority,
        status=wi.status,
        title=wi.title,
        description=wi.description,
        assignee_id=wi.assignee_id,
        assignee_username=wi.assignee.username if wi.assignee else None,
        start_time=wi.start_time,
        end_time=wi.end_time,
        mttr_seconds=wi.mttr_seconds,
        sla_deadline=wi.sla_deadline,
        sla_breached=sla_breached,
        created_at=wi.created_at,
        updated_at=wi.updated_at,
    )


async def create_work_item(data: WorkItemCreate, db: AsyncSession) -> str:
    wi_id = str(uuid.uuid4())
    now = _now()
    sla_deadline = now + timedelta(minutes=SLA_MINUTES.get(data.priority, 1440))

    wi = WorkItem(
        id=wi_id,
        component=data.component,
        priority=data.priority,
        status="OPEN",
        title=data.title,
        description=data.description,
        start_time=now,
        sla_deadline=sla_deadline,
        created_at=now,
        updated_at=now,
    )
    db.add(wi)
    await db.flush()
    await _invalidate_cache()
    return wi_id


async def get_work_item(wi_id: str, db: AsyncSession) -> WorkItemResponse | None:
    cached = await cache.get_val(f"wi:{wi_id}")
    if cached:
        return WorkItemResponse(**cached)

    result = await db.execute(
        select(WorkItem)
        .options(selectinload(WorkItem.assignee))
        .where(WorkItem.id == wi_id)
    )
    wi = result.scalar_one_or_none()
    if not wi:
        return None

    resp = _wi_to_response(wi)
    await cache.set_val(f"wi:{wi_id}", resp.model_dump(mode="json"), ttl=60)
    return resp


async def list_work_items(db: AsyncSession, status: str | None = None) -> list[WorkItemResponse]:
    cache_key = f"wi:list:{status or 'all'}"
    cached = await cache.get_val(cache_key)
    if cached:
        return [WorkItemResponse(**i) for i in cached]

    q = select(WorkItem).options(selectinload(WorkItem.assignee))
    if status:
        q = q.where(WorkItem.status == status)
    q = q.order_by(WorkItem.priority, WorkItem.created_at.desc())

    result = await db.execute(q)
    items = [_wi_to_response(wi) for wi in result.scalars().all()]
    await cache.set_val(cache_key, [i.model_dump(mode="json") for i in items], ttl=30)
    return items


async def transition_status(wi_id: str, new_status: str, db: AsyncSession) -> WorkItemResponse:
    result = await db.execute(
        select(WorkItem).options(selectinload(WorkItem.assignee)).where(WorkItem.id == wi_id)
    )
    wi = result.scalar_one_or_none()
    if not wi:
        raise ValueError(f"Work item {wi_id} not found")

    validate_transition(wi.status, new_status)

    if new_status == "CLOSED":
        rca = await db.execute(select(RCARecord).where(RCARecord.work_item_id == wi_id))
        if not rca.scalar_one_or_none():
            raise ValueError("Cannot CLOSE: RCA record missing.")

    now = _now()
    wi.status = new_status
    wi.updated_at = now

    if new_status in ("RESOLVED", "CLOSED"):
        wi.end_time = now
        wi.mttr_seconds = int((now - wi.start_time).total_seconds())

    await db.flush()
    await _invalidate_cache(wi_id)
    return _wi_to_response(wi)


async def assign_work_item(wi_id: str, assignee_id: str | None, db: AsyncSession) -> WorkItemResponse:
    result = await db.execute(
        select(WorkItem).options(selectinload(WorkItem.assignee)).where(WorkItem.id == wi_id)
    )
    wi = result.scalar_one_or_none()
    if not wi:
        raise ValueError(f"Work item {wi_id} not found")
    wi.assignee_id = assignee_id
    wi.updated_at = _now()
    await db.flush()
    await _invalidate_cache(wi_id)
    return _wi_to_response(wi)


async def submit_rca(wi_id: str, data: RCASubmit, db: AsyncSession, user_id: str | None = None) -> RCAResponse:
    result = await db.execute(select(WorkItem).where(WorkItem.id == wi_id))
    wi = result.scalar_one_or_none()
    if not wi:
        raise ValueError(f"Work item {wi_id} not found")
    if wi.status == "OPEN":
        raise ValueError("Cannot submit RCA for OPEN incident.")

    # Upsert RCA
    existing = await db.execute(select(RCARecord).where(RCARecord.work_item_id == wi_id))
    rca = existing.scalar_one_or_none()
    now = _now()

    inc_start = datetime.fromisoformat(data.incident_start.replace("Z", "+00:00"))
    inc_end = datetime.fromisoformat(data.incident_end.replace("Z", "+00:00"))

    if rca:
        rca.incident_start = inc_start
        rca.incident_end = inc_end
        rca.root_cause_category = data.root_cause_category
        rca.fix_applied = data.fix_applied
        rca.prevention_steps = data.prevention_steps
        rca.submitted_by = user_id
        rca.submitted_at = now
    else:
        rca = RCARecord(
            id=str(uuid.uuid4()),
            work_item_id=wi_id,
            incident_start=inc_start,
            incident_end=inc_end,
            root_cause_category=data.root_cause_category,
            fix_applied=data.fix_applied,
            prevention_steps=data.prevention_steps,
            submitted_by=user_id,
            submitted_at=now,
        )
        db.add(rca)

    await db.flush()
    await _invalidate_cache(wi_id)
    return RCAResponse(
        id=rca.id,
        work_item_id=wi_id,
        incident_start=rca.incident_start,
        incident_end=rca.incident_end,
        root_cause_category=rca.root_cause_category,
        fix_applied=rca.fix_applied,
        prevention_steps=rca.prevention_steps,
        submitted_by=rca.submitted_by,
        submitted_at=rca.submitted_at,
    )


async def get_rca(wi_id: str, db: AsyncSession) -> RCAResponse | None:
    result = await db.execute(select(RCARecord).where(RCARecord.work_item_id == wi_id))
    rca = result.scalar_one_or_none()
    if not rca:
        return None
    return RCAResponse(
        id=rca.id, work_item_id=wi_id,
        incident_start=rca.incident_start, incident_end=rca.incident_end,
        root_cause_category=rca.root_cause_category, fix_applied=rca.fix_applied,
        prevention_steps=rca.prevention_steps, submitted_by=rca.submitted_by,
        submitted_at=rca.submitted_at,
    )


async def add_comment(wi_id: str, data: CommentCreate, author_id: str, db: AsyncSession) -> CommentResponse:
    result = await db.execute(select(WorkItem).where(WorkItem.id == wi_id))
    if not result.scalar_one_or_none():
        raise ValueError(f"Work item {wi_id} not found")

    comment = Comment(
        id=str(uuid.uuid4()),
        work_item_id=wi_id,
        author_id=author_id,
        body=data.body,
        created_at=_now(),
    )
    db.add(comment)
    await db.flush()

    # Load author username
    user = await db.get(User, author_id)
    return CommentResponse(
        id=comment.id, work_item_id=wi_id, author_id=author_id,
        author_username=user.username if user else None,
        body=comment.body, created_at=comment.created_at,
    )


async def list_comments(wi_id: str, db: AsyncSession) -> list[CommentResponse]:
    result = await db.execute(
        select(Comment).options(selectinload(Comment.author))
        .where(Comment.work_item_id == wi_id)
        .order_by(Comment.created_at)
    )
    return [
        CommentResponse(
            id=c.id, work_item_id=wi_id, author_id=c.author_id,
            author_username=c.author.username if c.author else None,
            body=c.body, created_at=c.created_at,
        )
        for c in result.scalars().all()
    ]


async def get_mttr_stats(db: AsyncSession, component: str | None = None) -> list[MTTRStats]:
    q = select(
        WorkItem.component,
        func.avg(WorkItem.mttr_seconds).label("avg_mttr"),
        func.min(WorkItem.mttr_seconds).label("min_mttr"),
        func.max(WorkItem.mttr_seconds).label("max_mttr"),
        func.count(WorkItem.id).label("cnt"),
    ).where(WorkItem.mttr_seconds.isnot(None))

    if component:
        q = q.where(WorkItem.component == component)
    q = q.group_by(WorkItem.component)

    result = await db.execute(q)
    return [
        MTTRStats(
            component=row.component,
            avg_mttr_seconds=row.avg_mttr,
            min_mttr_seconds=row.min_mttr,
            max_mttr_seconds=row.max_mttr,
            incident_count=row.cnt,
        )
        for row in result.all()
    ]


async def get_sla_stats(db: AsyncSession) -> SLAStats:
    total_r = await db.execute(select(func.count(WorkItem.id)))
    total = total_r.scalar() or 0

    now = _now()
    breached_r = await db.execute(
        select(func.count(WorkItem.id)).where(
            WorkItem.sla_deadline < now,
            WorkItem.status.notin_(["RESOLVED", "CLOSED"]),
        )
    )
    breached = breached_r.scalar() or 0
    return SLAStats(
        total=total,
        breached=breached,
        breach_rate_pct=round(breached / total * 100, 1) if total else 0.0,
    )


async def _invalidate_cache(wi_id: str | None = None):
    if wi_id:
        await cache.delete_val(f"wi:{wi_id}")
    await cache.delete_pattern("wi:list:*")