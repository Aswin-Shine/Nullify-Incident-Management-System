"""Work Item service — PostgreSQL + Redis + SLA + comments."""
from __future__ import annotations
import base64
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select, func, tuple_, update, literal_column, text
from sqlalchemy.engine import Row
from sqlalchemy.orm import selectinload

from app.db.postgres import ACTIVE_WHERE, WorkItem, RCARecord, Comment, Signal, User
from app.db import cache
from app.models.schemas import (
    WorkItemCreate, WorkItemResponse, RCASubmit, RCAResponse,
    CommentCreate, CommentResponse, MTTRStats, SLAStats
)
from app.services.alert_strategy import get_alert_strategy
from app.services.state_machine import get_state, InvalidTransitionError

logger = logging.getLogger("ims.work_item")

class ConflictError(Exception):
    """The Work Item changed underneath this request (maps to HTTP 409)."""


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
        signal_count=wi.signal_count,
        last_signal_at=wi.last_signal_at,
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
    await invalidate_cache()
    return wi_id


async def upsert_active_work_item(
    db: AsyncSession, component: str, occurred_at: datetime, signal_type: str, message: str,
    component_type: str | None = None,
) -> Row:
    """Attach a signal to the component's active (OPEN/INVESTIGATING) Work Item, creating one if needed.

    A single INSERT ... ON CONFLICT against the partial unique index `ux_wi_active_component`, so
    concurrent callers in any process agree on one incident. Returns the row with a `created` flag.
    """
    strategy = get_alert_strategy(component, component_type)
    priority = strategy.priority()
    now = _now()
    ins = pg_insert(WorkItem).values(
        id=str(uuid.uuid4()), component=component, priority=priority, status="OPEN",
        title=f"{component} - {signal_type}", description=strategy.notify(component, message),
        start_time=occurred_at, last_signal_at=occurred_at, signal_count=1,
        sla_deadline=occurred_at + timedelta(minutes=SLA_MINUTES[priority]),
        created_at=now, updated_at=now,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=[WorkItem.component],
        index_where=text(ACTIVE_WHERE),
        set_={
            "signal_count": WorkItem.signal_count + 1,
            "start_time": func.least(WorkItem.start_time, ins.excluded.start_time),
            "last_signal_at": func.greatest(WorkItem.last_signal_at, ins.excluded.last_signal_at),
            "updated_at": now,
        },
    ).returning(
        WorkItem.id, WorkItem.component, WorkItem.priority, WorkItem.title, WorkItem.description,
        literal_column("xmax = 0").label("created"),  # true when this statement inserted the row
    )
    return (await db.execute(stmt)).one()


async def list_signals(wi_id: str, db: AsyncSession, limit: int = 200) -> list[dict]:
    """The incident's most recent `limit` signals, oldest first, in the raw payload shape the UI reads."""
    rows = (await db.execute(
        select(Signal).where(Signal.work_item_id == wi_id)
        .order_by(Signal.occurred_at.desc(), Signal.id.desc()).limit(limit)
    )).scalars().all()
    return [{**s.payload, "id": s.id, "work_item_id": s.work_item_id} for s in reversed(rows)]


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


MAX_PAGE = 500


def _encode_cursor(wi: WorkItem) -> str:
    raw = json.dumps([wi.priority, wi.created_at.isoformat(), wi.id])
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[str, datetime, str]:
    try:
        priority, created_at, wi_id = json.loads(base64.urlsafe_b64decode(cursor))
        created = datetime.fromisoformat(created_at)
        if priority not in SLA_MINUTES or not isinstance(wi_id, str) or created.tzinfo is None:
            raise ValueError
        return priority, created, wi_id
    except Exception:
        raise ValueError("Invalid cursor") from None


async def list_work_items(
    db: AsyncSession, status: str | None = None, limit: int = 100, cursor: str | None = None
) -> dict:
    """One page, ordered priority then newest first then id: {"items": [...], "next_cursor": str | None}.

    Keyset pagination: the cursor is the last row's sort key, so pages stay stable while incidents
    are created. Pages are cached under a generation counter that every write bumps (no KEYS scan).
    """
    limit = min(max(limit, 1), MAX_PAGE)
    after = _decode_cursor(cursor) if cursor else None  # validated before the cache, so a bad cursor is always 422

    gen = await cache.get_val("wi:list:gen") or 0
    cache_key = f"wi:list:{gen}:{status or 'all'}:{limit}:{cursor or ''}"
    cached = await cache.get_val(cache_key)
    if cached:
        return cached

    q = select(WorkItem).options(selectinload(WorkItem.assignee))
    if status:
        q = q.where(WorkItem.status == status)
    if after:
        p, c, i = after
        q = q.where(or_(WorkItem.priority > p,
                        and_(WorkItem.priority == p, tuple_(WorkItem.created_at, WorkItem.id) < tuple_(c, i))))
    q = q.order_by(WorkItem.priority, WorkItem.created_at.desc(), WorkItem.id.desc()).limit(limit + 1)

    rows = (await db.execute(q)).scalars().all()
    page = {
        "items": [_wi_to_response(wi).model_dump(mode="json") for wi in rows[:limit]],
        "next_cursor": _encode_cursor(rows[limit - 1]) if len(rows) > limit else None,
    }
    await cache.set_val(cache_key, page, ttl=30)
    return page


async def _load_response(wi_id: str, db: AsyncSession) -> WorkItemResponse:
    wi = (await db.execute(
        select(WorkItem).options(selectinload(WorkItem.assignee)).where(WorkItem.id == wi_id)
        .execution_options(populate_existing=True)
    )).scalar_one()
    return _wi_to_response(wi)


async def transition_status(wi_id: str, new_status: str, db: AsyncSession) -> WorkItemResponse:
    """Move a Work Item through the state machine with a compare-and-set UPDATE.

    The write applies only if the status is still the one we validated against (and, for CLOSED,
    an RCA exists), so concurrent requests cannot both win. Commits before any side effect.
    """
    current = (await db.execute(select(WorkItem.status).where(WorkItem.id == wi_id))).scalar_one_or_none()
    if current is None:
        raise ValueError(f"Work item {wi_id} not found")

    target = get_state(current).transition_to(new_status)

    conditions = [WorkItem.id == wi_id, WorkItem.status == current, *target.entry_conditions(wi_id)]
    updated = (await db.execute(
        update(WorkItem).where(*conditions).values(status=new_status, updated_at=_now()).returning(WorkItem.id)
    )).scalar_one_or_none()

    if updated is None:
        latest = (await db.execute(select(WorkItem.status).where(WorkItem.id == wi_id))).scalar_one()
        if latest != current:
            raise ConflictError(f"Work item moved to {latest} while this request was in flight.")
        raise ValueError(target.guard_message)

    await db.commit()
    await invalidate_cache(wi_id)
    return await _load_response(wi_id, db)


async def assign_work_item(wi_id: str, assignee_id: str | None, db: AsyncSession) -> WorkItemResponse:
    result = await db.execute(select(WorkItem).where(WorkItem.id == wi_id))
    wi = result.scalar_one_or_none()
    if not wi:
        raise ValueError(f"Work item {wi_id} not found")
    if assignee_id is not None and await db.get(User, assignee_id) is None:
        raise ValueError("Assignee not found")  # 422 instead of a foreign-key 500 at commit
    wi.assignee_id = assignee_id
    wi.updated_at = _now()
    await db.commit()
    await invalidate_cache(wi_id)
    return await _load_response(wi_id, db)


async def submit_rca(wi_id: str, data: RCASubmit, db: AsyncSession, user_id: str | None = None) -> RCAResponse:
    """Create or update the RCA and record MTTR (first signal -> RCA submission).

    The Work Item row is locked so a concurrent CLOSE waits for this commit; once CLOSED the RCA
    is immutable.
    """
    result = await db.execute(select(WorkItem).where(WorkItem.id == wi_id).with_for_update())
    wi = result.scalar_one_or_none()
    if not wi:
        raise ValueError(f"Work item {wi_id} not found")
    if wi.status == "CLOSED":
        raise ConflictError("RCA is locked once the incident is CLOSED.")
    if wi.status == "OPEN":
        raise ValueError("Cannot submit RCA for OPEN incident.")

    existing = await db.execute(select(RCARecord).where(RCARecord.work_item_id == wi_id))
    rca = existing.scalar_one_or_none()
    now = _now()
    inc_start, inc_end = data.incident_start, data.incident_end

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

    # MTTR per spec: start_time is the first signal, end_time is the RCA submission.
    wi.end_time = now
    wi.mttr_seconds = int((now - wi.start_time).total_seconds())
    wi.updated_at = now

    await db.commit()
    await invalidate_cache(wi_id)
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
    await db.commit()  # commit before the router broadcasts comment_added

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

    by_priority = await db.execute(
        select(WorkItem.priority, func.count(WorkItem.id))
        .where(WorkItem.status.notin_(["RESOLVED", "CLOSED"]))
        .group_by(WorkItem.priority)
    )
    open_by_priority = {p: 0 for p in ("P0", "P1", "P2", "P3")}
    open_by_priority.update(dict(by_priority.all()))
    return SLAStats(
        total=total,
        breached=breached,
        breach_rate_pct=round(breached / total * 100, 1) if total else 0.0,
        open_by_priority=open_by_priority,
    )


async def invalidate_cache(wi_id: str | None = None):
    """Drop cached dashboard reads. Call only after the write has committed."""
    if wi_id:
        await cache.delete_val(f"wi:{wi_id}")
    await cache.bump("wi:list:gen")