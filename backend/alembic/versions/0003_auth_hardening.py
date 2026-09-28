"""Auth hardening: hashed API keys, token_version for revocation.

- users.api_key (plaintext) -> users.api_key_hash (sha256 hex). Existing keys are hashed in place,
  so keys already handed out keep working.
- users.token_version: embedded in every JWT; bumping it revokes all of that user's tokens.

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-28
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("api_key_hash", sa.String(64)))
    op.execute("UPDATE users SET api_key_hash = encode(sha256(api_key::bytea), 'hex') WHERE api_key IS NOT NULL")
    op.create_unique_constraint("uq_users_api_key_hash", "users", ["api_key_hash"])
    op.drop_column("users", "api_key")


def downgrade() -> None:
    # Plaintext keys cannot be recovered from their hashes; users must rotate after a downgrade.
    op.add_column("users", sa.Column("api_key", sa.String(64), unique=True))
    op.drop_constraint("uq_users_api_key_hash", "users", type_="unique")
    op.drop_column("users", "api_key_hash")
    op.drop_column("users", "token_version")
