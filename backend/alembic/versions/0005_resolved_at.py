"""work_items.resolved_at: when the incident was marked RESOLVED (drives the "RCA overdue" marker).

Backfills finished incidents from their latest status event to RESOLVED, else from updated_at
(incidents resolved before 0004 have no events).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("work_items", sa.Column("resolved_at", sa.DateTime(timezone=True)))
    op.execute("""
        UPDATE work_items wi SET resolved_at = COALESCE(
            (SELECT max(e.created_at) FROM work_item_events e
              WHERE e.work_item_id = wi.id AND e.kind = 'status' AND e.to_value = 'RESOLVED'),
            wi.updated_at)
        WHERE wi.status IN ('RESOLVED', 'CLOSED')
    """)


def downgrade() -> None:
    op.drop_column("work_items", "resolved_at")
