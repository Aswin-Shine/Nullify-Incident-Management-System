"""Account creation, shared by the admin API and the bootstrap CLI (accounts are invite-only)."""
from __future__ import annotations
import asyncio
import logging

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.db.postgres import User
from app.models.schemas import UserCreate

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
