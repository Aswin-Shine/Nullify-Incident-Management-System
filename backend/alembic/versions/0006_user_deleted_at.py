"""users.deleted_at: an admin deleted the account. The row stays (anonymised) so comments, history and the owner
of finished incidents keep a valid reference, shown as "Deleted user".

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-04
"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    op.drop_column("users", "deleted_at")
