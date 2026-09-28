"""FastAPI auth dependencies."""
from __future__ import annotations
from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, APIKeyHeader
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.security import decode_token, hash_api_key
from app.db.postgres import get_db, User

bearer = HTTPBearer(auto_error=False)
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def user_from_access_token(token: str, db: AsyncSession) -> User | None:
    """Active user for a live access token; None if invalid, expired, the wrong type, or revoked."""
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        return None
    user = (await db.execute(
        select(User).where(User.id == payload["sub"], User.is_active == True)  # noqa: E712
    )).scalar_one_or_none()
    if user is None or payload.get("tv") != user.token_version:
        return None
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
    api_key: str | None = Security(api_key_header),
    db: AsyncSession = Depends(get_db),
) -> User:
    if api_key:  # signal producers
        user = (await db.execute(
            select(User).where(User.api_key_hash == hash_api_key(api_key), User.is_active == True)  # noqa: E712
        )).scalar_one_or_none()
        if user:
            return user

    if credentials:
        user = await user_from_access_token(credentials.credentials, db)
        if user:
            return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_active_user(user: User = Depends(get_current_user)) -> User:
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return user


def require_role(*roles: str):
    async def _check(user: User = Depends(get_current_active_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user
    return _check


# Convenience role guards
require_admin = require_role("admin")
require_sre_or_admin = require_role("sre", "admin")
any_authenticated = get_current_active_user
