"""work_items.resolution_note: how the incident was fixed, required when it is marked RESOLVED.

Incidents resolved before this revision keep a null note: there is nothing to backfill from.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("work_items", sa.Column("resolution_note", sa.Text()))


def downgrade() -> None:
    op.drop_column("work_items", "resolution_note")
