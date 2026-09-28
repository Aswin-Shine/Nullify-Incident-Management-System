"""Linked signals, one active incident per component, real timeseries counts.

- work_items: signal_count, last_signal_at, partial unique index (one OPEN/INVESTIGATING per component)
- signals: raw signals linked to their Work Item
- timeseries_agg: merge duplicate (bucket, component) rows, then enforce uniqueness

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-28
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

ACTIVE = "status IN ('OPEN','INVESTIGATING')"


def upgrade() -> None:
    conn = op.get_bind()

    op.add_column("work_items", sa.Column("signal_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("work_items", sa.Column("last_signal_at", sa.DateTime(timezone=True)))

    dupes = conn.execute(sa.text(
        f"SELECT component, count(*) FROM work_items WHERE {ACTIVE} GROUP BY component HAVING count(*) > 1"
    )).all()
    if dupes:
        raise RuntimeError(
            "Cannot enforce one active incident per component; resolve these duplicates first: "
            + ", ".join(f"{c} ({n})" for c, n in dupes)
        )
    op.create_index("ux_wi_active_component", "work_items", ["component"], unique=True,
                    postgresql_where=sa.text(ACTIVE))

    op.create_table(
        "signals",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("work_item_id", sa.String(36), sa.ForeignKey("work_items.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("component", sa.String(128), nullable=False),
        sa.Column("signal_type", sa.String(64), nullable=False),
        sa.Column("severity", sa.String(32)),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("payload", JSONB(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_signals_work_item_occurred", "signals", ["work_item_id", "occurred_at"])

    # The old code inserted one row per signal; fold them into one row per (bucket, component).
    conn.execute(sa.text("""
        WITH totals AS (
            SELECT min(id) AS keep_id, bucket, component, sum(signal_count) AS total
            FROM timeseries_agg GROUP BY bucket, component
        )
        UPDATE timeseries_agg t SET signal_count = totals.total
        FROM totals WHERE t.id = totals.keep_id
    """))
    conn.execute(sa.text("""
        DELETE FROM timeseries_agg t
        WHERE t.id <> (SELECT min(id) FROM timeseries_agg d
                       WHERE d.bucket = t.bucket AND d.component = t.component)
    """))
    op.drop_index("ix_ts_bucket_component", table_name="timeseries_agg")
    op.create_unique_constraint("uq_ts_bucket_component", "timeseries_agg", ["bucket", "component"])


def downgrade() -> None:
    op.drop_constraint("uq_ts_bucket_component", "timeseries_agg", type_="unique")
    op.create_index("ix_ts_bucket_component", "timeseries_agg", ["bucket", "component"])
    op.drop_table("signals")
    op.drop_index("ux_wi_active_component", table_name="work_items")
    op.drop_column("work_items", "last_signal_at")
    op.drop_column("work_items", "signal_count")
