"""Incident history: work_item_events.

One row per change to a Work Item (opened, status change, assignment, RCA submitted), written in
the same transaction as the change. actor_id is null when the system acted (ingestion).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-03
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "work_item_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("work_item_id", sa.String(36), sa.ForeignKey("work_items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("actor_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("from_value", sa.String(64)),
        sa.Column("to_value", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_wi_events_work_item_created", "work_item_events", ["work_item_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_wi_events_work_item_created", table_name="work_item_events")
    op.drop_table("work_item_events")
