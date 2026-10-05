"""Test data builders that the app itself never needs."""
import uuid
from datetime import datetime, timedelta, timezone

from app.db.postgres import WorkItem
from app.services.work_item_service import SLA_MINUTES, invalidate_cache


async def create_work_item(db, *, component: str, priority: str, title: str) -> str:
    """An OPEN work item with no signals (production ones are only ever opened by ingestion). Caller commits."""
    now = datetime.now(timezone.utc)
    wi = WorkItem(id=str(uuid.uuid4()), component=component, priority=priority, status="OPEN", title=title,
                  start_time=now, sla_deadline=now + timedelta(minutes=SLA_MINUTES[priority]),
                  created_at=now, updated_at=now)
    db.add(wi)
    await db.flush()
    await invalidate_cache()
    return wi.id
