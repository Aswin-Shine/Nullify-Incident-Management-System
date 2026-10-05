"""Usernames and emails are unique regardless of case.

Stops if the table already holds two accounts that differ only in case, naming them, so an operator decides which
one to rename; the indexes would fail anyway, with a less helpful message.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-05
"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    clashes = op.get_bind().execute(sa.text("""
        SELECT 'username', lower(username) FROM users GROUP BY lower(username) HAVING count(*) > 1
        UNION ALL
        SELECT 'email', lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
    """)).all()
    if clashes:
        raise RuntimeError("Accounts differ only in case; rename one of each before upgrading: "
                           + ", ".join(f"{kind} {value!r}" for kind, value in clashes))
    op.create_index("ux_users_username_lower", "users", [sa.text("lower(username)")], unique=True)
    op.create_index("ux_users_email_lower", "users", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index("ux_users_email_lower", table_name="users")
    op.drop_index("ux_users_username_lower", table_name="users")
