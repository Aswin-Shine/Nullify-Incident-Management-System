"""Work Item service — PostgreSQL + Redis + SLA + comments."""
from __future__ import annotations
import base64
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select, func, tuple_, update, literal_column, text
from sqlalchemy.engine import Row
from sqlalchemy.orm import selectinload

from app.core.metrics import TRANSITIONS
from app.db.postgres import ACTIVE_WHERE, WorkItem, WorkItemEvent, RCARecord, Comment, Signal, User
from app.db import cache
from app.models.schemas import (
    WorkItemResponse, RCASubmit, RCAResponse,
    CommentCreate, CommentResponse, MTTRStats, SLAStats, WorkItemEventResponse
)
from app.services.alert_strategy import get_alert_strategy
from app.services.state_machine import get_state

logger = logging.getLogger("ims.work_item")

class ConflictError(Exception):
    """The Work Item changed underneath this request (maps to HTTP 409)."""


class NotFoundError(Exception):
    """No Work Item with this id (a handler in main.py maps it to HTTP 404)."""


# SLA deadlines by priority (minutes to acknowledge)
SLA_MINUTES = {"P0": 15, "P1": 60, "P2": 240, "P3": 1440}


def _now() -> datetime:
    return datetime.now(timezone.utc)


DELETED_USER = "Deleted user"


def display_name(user: User | None) -> str | None:
    """The name to show for a person: "Deleted user" once an admin deleted the account (the row stays, anonymised)."""
    if user is None:
        return None
    return DELETED_USER if user.deleted_at else user.username


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
        assignee_username=display_name(wi.assignee),
        start_time=wi.start_time,
        end_time=wi.end_time,
        resolved_at=wi.resolved_at,
        resolution_note=wi.resolution_note,
        mttr_seconds=wi.mttr_seconds,
        sla_deadline=wi.sla_deadline,
        sla_breached=sla_breached,
        signal_count=wi.signal_count,
        last_signal_at=wi.last_signal_at,
        created_at=wi.created_at,
        updated_at=wi.updated_at,
    )


def record_event(
    db: AsyncSession, wi_id: str, kind: str, actor_id: str | None = None,
    from_value: str | None = None, to_value: str | None = None,
) -> None:
    """Queue a history row on the caller's session. It commits (or rolls back) with the change it records."""
    db.add(WorkItemEvent(
        id=str(uuid.uuid4()), work_item_id=wi_id, kind=kind, actor_id=actor_id,
        from_value=from_value, to_value=to_value, created_at=_now(),
    ))


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


def _detail_key(wi_id: str, version) -> str:
    return f"wi:{wi_id}:v{version or 0}"


async def get_work_item(wi_id: str, db: AsyncSession) -> WorkItemResponse | None:
    # The version is read before the DB: a write that commits meanwhile bumps it, so this read's (older) answer lands
    # on a key nobody asks for again instead of shadowing the write for the TTL.
    version = await cache.get_val(f"wi:{wi_id}:ver")
    cached = await cache.get_val(_detail_key(wi_id, version))
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
    await cache.set_val(_detail_key(wi_id, version), resp.model_dump(mode="json"), ttl=60)
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


def _like_escape(q: str) -> str:
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def list_work_items(
    db: AsyncSession, status: str | None = None, limit: int = 100, cursor: str | None = None,
    q: str | None = None, priority: str | None = None, assignee: str | None = None,
) -> dict:
    """One page, ordered priority then newest first then id: {"items": [...], "next_cursor": str | None, "total": int}
    (`total` counts every row matching the filters, not just this page).

    Filters: `status` is one status or "ACTIVE" (OPEN or INVESTIGATING); `q` is a literal, case-insensitive substring of the component; `assignee` is a user id or
    "none" (unassigned). The router has already validated them and resolved "me" to the caller's id.

    Keyset pagination: the cursor is the last row's sort key, so pages stay stable while incidents
    are created. Pages are cached under a generation counter that every write bumps (no KEYS scan).
    """
    limit = min(max(limit, 1), MAX_PAGE)
    after = _decode_cursor(cursor) if cursor else None  # validated before the cache, so a bad cursor is always 422

    gen = await cache.get_val("wi:list:gen") or 0
    cache_key = f"wi:list:{gen}:{status or 'all'}:{limit}:{cursor or ''}:{priority or ''}:{assignee or ''}:{q or ''}"
    cached = await cache.get_val(cache_key)
    if cached:
        return cached

    # One list of filter clauses feeds both the page and the total, so the two cannot drift.
    filters = []
    if status == "ACTIVE":  # the incidents someone still has to act on
        filters.append(WorkItem.status.in_(["OPEN", "INVESTIGATING"]))
    elif status:
        filters.append(WorkItem.status == status)
    if priority:
        filters.append(WorkItem.priority == priority)
    if assignee == "none":
        filters.append(WorkItem.assignee_id.is_(None))
    elif assignee:
        filters.append(WorkItem.assignee_id == assignee)
    if q:
        filters.append(WorkItem.component.ilike(f"%{_like_escape(q)}%", escape="\\"))
    stmt = select(WorkItem).options(selectinload(WorkItem.assignee)).where(*filters)
    if after:
        p, c, i = after
        stmt = stmt.where(or_(WorkItem.priority > p,
                              and_(WorkItem.priority == p, tuple_(WorkItem.created_at, WorkItem.id) < tuple_(c, i))))
    stmt = stmt.order_by(WorkItem.priority, WorkItem.created_at.desc(), WorkItem.id.desc()).limit(limit + 1)

    rows = (await db.execute(stmt)).scalars().all()
    total = (await db.execute(select(func.count()).select_from(WorkItem).where(*filters))).scalar_one()  # ignores cursor and limit
    page = {
        "items": [_wi_to_response(wi).model_dump(mode="json") for wi in rows[:limit]],
        "next_cursor": _encode_cursor(rows[limit - 1]) if len(rows) > limit else None,
        "total": total,
    }
    await cache.set_val(cache_key, page, ttl=30)
    return page


async def _load_response(wi_id: str, db: AsyncSession) -> WorkItemResponse:
    wi = (await db.execute(
        select(WorkItem).options(selectinload(WorkItem.assignee)).where(WorkItem.id == wi_id)
        .execution_options(populate_existing=True)
    )).scalar_one()
    return _wi_to_response(wi)


async def transition_status(
    wi_id: str, new_status: str, db: AsyncSession, actor_id: str | None = None, note: str | None = None
) -> WorkItemResponse:
    """Move a Work Item through the state machine with a compare-and-set UPDATE.

    The write applies only if the status is still the one we validated against (and, for CLOSED,
    an RCA exists), so concurrent requests cannot both win. Starting an investigation also claims an
    unowned incident for the actor (an existing owner is kept). RESOLVED needs `note` (how it was fixed),
    stored by the same UPDATE. Commits before any side effect.
    """
    row = (await db.execute(select(WorkItem.status, WorkItem.assignee_id).where(WorkItem.id == wi_id))).one_or_none()
    if row is None:
        raise NotFoundError("Work item not found")
    current, owner_before = row

    target = get_state(current).transition_to(new_status)
    if new_status == "RESOLVED" and not note:
        raise ValueError("A resolution note is required: say how it was fixed.")

    conditions = [WorkItem.id == wi_id, WorkItem.status == current, *target.entry_conditions(wi_id)]
    values = {"status": new_status, "updated_at": _now()}
    if new_status == "RESOLVED":
        values["resolved_at"] = values["updated_at"]
        values["resolution_note"] = note
    if new_status == "INVESTIGATING" and actor_id:
        values["assignee_id"] = func.coalesce(WorkItem.assignee_id, actor_id)
    updated = (await db.execute(
        update(WorkItem).where(*conditions).values(**values).returning(WorkItem.id, WorkItem.assignee_id)
    )).one_or_none()

    if updated is None:
        latest = (await db.execute(select(WorkItem.status).where(WorkItem.id == wi_id))).scalar_one()
        if latest != current:
            raise ConflictError(f"Work item moved to {latest} while this request was in flight.")
        raise ValueError(target.guard_message)

    record_event(db, wi_id, "status", actor_id, current, new_status)  # same transaction as the UPDATE
    if actor_id and owner_before is None and updated.assignee_id == actor_id:
        claimer = await db.get(User, actor_id)
        record_event(db, wi_id, "assigned", actor_id, None, claimer.username if claimer else None)
    await db.commit()
    TRANSITIONS.labels(to=new_status).inc()
    await invalidate_cache(wi_id)
    return await _load_response(wi_id, db)


async def assign_work_item(
    wi_id: str, assignee_id: str | None, db: AsyncSession, actor_id: str | None = None
) -> WorkItemResponse:
    """Compare-and-set like transition_status: the owner must still be the one read, or the request lost a race (409)."""
    row = (await db.execute(select(WorkItem.status, WorkItem.assignee_id).where(WorkItem.id == wi_id))).one_or_none()
    if row is None:
        raise NotFoundError("Work item not found")
    status, seen = row
    if status == "CLOSED":
        raise ConflictError("A closed incident's owner is part of its record and cannot change.")
    new_owner = await db.get(User, assignee_id) if assignee_id is not None else None
    if assignee_id is not None and new_owner is None:
        raise ValueError("Assignee not found")  # 422 instead of a foreign-key 500 at commit
    if new_owner is not None and not (new_owner.is_active and new_owner.role in ("sre", "admin")):
        raise ValueError("Assignee must be an active SRE or admin")
    if seen != assignee_id:
        changed = (await db.execute(
            update(WorkItem)
            .where(WorkItem.id == wi_id, WorkItem.assignee_id.is_not_distinct_from(seen), WorkItem.status != "CLOSED")
            .values(assignee_id=assignee_id, updated_at=_now()).returning(WorkItem.id)
        )).one_or_none()
        if changed is None:
            raise ConflictError("The incident changed while this request was in flight. Reload and try again.")
        old_owner = await db.get(User, seen) if seen else None
        record_event(db, wi_id, "assigned", actor_id,
                     old_owner.username if old_owner else None, new_owner.username if new_owner else None)
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
        raise NotFoundError("Work item not found")
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

    record_event(db, wi_id, "rca_submitted", user_id)
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
        raise NotFoundError("Work item not found")

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
    if (await db.execute(select(WorkItem.id).where(WorkItem.id == wi_id))).first() is None:
        raise NotFoundError("Work item not found")
    result = await db.execute(
        select(Comment).options(selectinload(Comment.author))
        .where(Comment.work_item_id == wi_id)
        .order_by(Comment.created_at)
    )
    return [
        CommentResponse(
            id=c.id, work_item_id=wi_id, author_id=c.author_id,
            author_username=display_name(c.author),
            body=c.body, created_at=c.created_at,
        )
        for c in result.scalars().all()
    ]


async def list_history(wi_id: str, db: AsyncSession) -> list[WorkItemEventResponse]:
    """The incident's events, oldest first."""
    rows = (await db.execute(
        select(WorkItemEvent).options(selectinload(WorkItemEvent.actor))
        .where(WorkItemEvent.work_item_id == wi_id)
        .order_by(WorkItemEvent.created_at, WorkItemEvent.id)
    )).scalars().all()
    return [
        WorkItemEventResponse(
            id=e.id, kind=e.kind, from_value=e.from_value, to_value=e.to_value,
            actor_username=display_name(e.actor), created_at=e.created_at,
        )
        for e in rows
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
    # Breached: still open past the deadline, or resolved after it. Resolving late does not undo a breach.
    breached_r = await db.execute(
        select(func.count(WorkItem.id)).where(or_(
            and_(WorkItem.status.notin_(["RESOLVED", "CLOSED"]), WorkItem.sla_deadline < now),
            WorkItem.resolved_at > WorkItem.sla_deadline,
        ))
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


async def open_counts_by_priority(db: AsyncSession) -> dict[str, int]:
    """OPEN and INVESTIGATING incidents per priority (priorities with none are absent)."""
    rows = await db.execute(
        select(WorkItem.priority, func.count()).where(WorkItem.status.in_(["OPEN", "INVESTIGATING"])).group_by(WorkItem.priority)
    )
    return dict(rows.all())


async def unassign_from_active(db: AsyncSession, user: User, actor_id: str) -> list[str]:
    """Unassign `user` from every OPEN or INVESTIGATING incident, with an "assigned" event each, on the caller's session
    (no commit). Finished incidents keep their owner: that is history. Returns the ids that changed."""
    ids = list((await db.execute(
        update(WorkItem).where(WorkItem.assignee_id == user.id, WorkItem.status.in_(["OPEN", "INVESTIGATING"]))
        .values(assignee_id=None, updated_at=_now()).returning(WorkItem.id)
    )).scalars())
    for wi_id in ids:
        record_event(db, wi_id, "assigned", actor_id, user.username, None)
    return ids


async def invalidate_cache(wi_id: str | None = None):
    """Drop cached dashboard reads. Call only after the write has committed."""
    if wi_id:
        await forget_detail(wi_id)
    await cache.bump("wi:list:gen")


async def forget_detail(wi_id: str):
    """Retire the cached detail of one incident (see get_work_item)."""
    await cache.bump(f"wi:{wi_id}:ver")