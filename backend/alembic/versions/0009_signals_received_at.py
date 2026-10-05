"""Index signals.received_at, so the daily retention job deletes old rows without scanning the table.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-05
"""
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_signals_received_at", "signals", ["received_at"])


def downgrade() -> None:
    op.drop_index("ix_signals_received_at", table_name="signals")
