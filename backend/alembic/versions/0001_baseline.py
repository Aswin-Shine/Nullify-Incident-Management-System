"""Baseline: schema as it existed when it was still created by Base.metadata.create_all.

Existing databases created by create_all should run `alembic stamp 0001` once, then
`alembic upgrade head`.

Revision ID: 0001
Revises:
Create Date: 2026-09-28
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True),
        sa.Column("email", sa.String(256), nullable=False, unique=True),
        sa.Column("hashed_password", sa.String(256), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("api_key", sa.String(64), unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_username", "users", ["username"], unique=True)

    op.create_table(
        "work_items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("component", sa.String(128), nullable=False),
        sa.Column("priority", sa.String(2), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("assignee_id", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True)),
        sa.Column("mttr_seconds", sa.Integer()),
        sa.Column("sla_deadline", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("priority IN ('P0','P1','P2','P3')", name="ck_priority"),
        sa.CheckConstraint("status IN ('OPEN','INVESTIGATING','RESOLVED','CLOSED')", name="ck_status"),
    )
    op.create_index("ix_work_items_status", "work_items", ["status"])
    op.create_index("ix_work_items_priority", "work_items", ["priority"])
    op.create_index("ix_work_items_component", "work_items", ["component"])

    op.create_table(
        "rca_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("work_item_id", sa.String(36), sa.ForeignKey("work_items.id", ondelete="CASCADE"),
                  nullable=False, unique=True),
        sa.Column("incident_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("incident_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("root_cause_category", sa.String(64), nullable=False),
        sa.Column("fix_applied", sa.Text(), nullable=False),
        sa.Column("prevention_steps", sa.Text(), nullable=False),
        sa.Column("submitted_by", sa.String(36), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "comments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("work_item_id", sa.String(36), sa.ForeignKey("work_items.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("author_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_comments_work_item_id", "comments", ["work_item_id"])

    op.create_table(
        "timeseries_agg",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("bucket", sa.String(20), nullable=False),
        sa.Column("component", sa.String(128), nullable=False),
        sa.Column("signal_count", sa.Integer(), nullable=False),
    )
    op.create_index("ix_ts_bucket_component", "timeseries_agg", ["bucket", "component"])


def downgrade() -> None:
    op.drop_table("timeseries_agg")
    op.drop_table("comments")
    op.drop_table("rca_records")
    op.drop_table("work_items")
    op.drop_table("users")
