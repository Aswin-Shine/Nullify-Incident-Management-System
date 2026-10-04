"""Account creation, shared by the admin API and the bootstrap CLI (accounts are invite-only)."""
from __future__ import annotations
import asyncio
import logging
import secrets
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.db.postgres import User
from app.models.schemas import UserCreate
from app.services.work_item_service import unassign_from_active

security_log = logging.getLogger("ims.security")


async def create_account(db: AsyncSession, data: UserCreate, created_by: str) -> User:
    """Create and commit a user. Raises ValueError if the username or email is taken."""
    taken = (await db.execute(
        select(User.id).where(or_(User.username == data.username, User.email == data.email))
    )).first()
    if taken:
        raise ValueError("Username or email already in use")

    user = User(
        username=data.username, email=data.email, role=data.role,
        hashed_password=await asyncio.to_thread(hash_password, data.password),
    )
    db.add(user)
    await db.commit()
    security_log.info("user_created by=%s user=%s role=%s", created_by, user.username, user.role)
    return user


async def delete_account(db: AsyncSession, user: User, admin: User) -> list[str]:
    """Delete `user` (by `admin`) and commit. The row is anonymised rather than removed, so comments, history and the
    owner of finished incidents keep a valid reference (shown as "Deleted user"); the username and email are freed.
    Their active incidents are unassigned. Returns the incident ids that changed, for the caller's side effects."""
    changed = await unassign_from_active(db, user, admin.id)  # first: the events name the person by their real name
    old_name = user.username
    user.username = f"deleted-{user.id[:8]}"
    user.email = f"deleted-{user.id}@deleted.invalid"
    user.hashed_password = await asyncio.to_thread(hash_password, secrets.token_urlsafe(32))  # nobody knows it
    user.api_key_hash = None
    user.is_active = False
    user.token_version += 1  # every session and token they hold stops working
    user.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    security_log.info("user_deleted by=%s user=%s unassigned=%d", admin.username, old_name, len(changed))
    return changed
