"""Auth router: invite-only accounts, cookie-based sessions, API keys.

Session model: login returns a short-lived access token (kept only in browser memory) and sets the
refresh token as an httpOnly, SameSite=Strict cookie scoped to /api/auth. Refresh and logout also
require an X-Requested-With header, which a cross-site page cannot send without a CORS preflight.
Changing a user's role, deactivating them, or logging out bumps token_version, revoking every
token issued before.
"""
from __future__ import annotations
import asyncio
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_active_user, require_admin, require_sre_or_admin, user_from_access_token
from app.core.rate_limit import auth_limit
from app.core.security import (
    create_access_token, create_refresh_token, decode_token, generate_api_key, hash_api_key,
    hash_password, verify_password,
)
from app.db.postgres import get_db, User
from app.models.schemas import (
    ApiKeyResponse, LoginRequest, PasswordChange, TokenResponse, UserCreate, UserPublic, UserResponse, UserUpdate,
)
from app.services.user_service import create_account, delete_account
from app.services.work_item_service import invalidate_cache
from app.services.ws_manager import manager as ws_manager

router = APIRouter(prefix="/api/auth", tags=["auth"])
security_log = logging.getLogger("ims.security")

REFRESH_COOKIE = "nullify_refresh"
COOKIE_PATH = "/api/auth"
_DUMMY_HASH = hash_password(secrets.token_hex(8))  # equalises timing for unknown usernames


def _ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _user_resp(u: User) -> UserResponse:
    return UserResponse(id=u.id, username=u.username, email=u.email, role=u.role,
                        is_active=u.is_active, created_at=u.created_at,
                        has_api_key=u.api_key_hash is not None)


def _claims(u: User) -> dict:
    return {"sub": u.id, "role": u.role, "tv": u.token_version}


def _cookie_attrs() -> dict:
    return {"httponly": True, "secure": get_settings().cookie_secure, "samesite": "strict", "path": COOKIE_PATH}


def _session(response: Response, user: User) -> TokenResponse:
    """Issue a fresh access token and (re)set the refresh cookie."""
    response.set_cookie(REFRESH_COOKIE, create_refresh_token(_claims(user)),
                        max_age=get_settings().jwt_refresh_token_expire_days * 86400, **_cookie_attrs())
    return TokenResponse(access_token=create_access_token(_claims(user)), user=_user_resp(user))


def require_csrf_header(request: Request) -> None:
    if request.headers.get("x-requested-with") != "nullify":
        raise HTTPException(403, "Missing X-Requested-With header")


async def _user_from_refresh_cookie(request: Request, db: AsyncSession) -> User | None:
    payload = decode_token(request.cookies.get(REFRESH_COOKIE, ""))
    if not payload or payload.get("type") != "refresh":
        return None
    user = (await db.execute(
        select(User).where(User.id == payload["sub"], User.is_active == True)  # noqa: E712
    )).scalar_one_or_none()
    return user if user and payload.get("tv") == user.token_version else None


# ── Sessions ──────────────────────────────────────────────────────────────


@router.post("/login", response_model=TokenResponse, dependencies=[Depends(auth_limit)])
async def login(data: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.username == data.username))).scalar_one_or_none()
    ok = await asyncio.to_thread(verify_password, data.password, user.hashed_password if user else _DUMMY_HASH)
    if not user or not ok:
        security_log.warning("login_failed username=%s ip=%s", data.username, _ip(request))
        raise HTTPException(401, "Invalid credentials")
    if not user.is_active:
        security_log.warning("login_blocked_inactive user=%s ip=%s", user.username, _ip(request))
        raise HTTPException(403, "Account disabled")
    return _session(response, user)


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(require_csrf_header)])
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    user = await _user_from_refresh_cookie(request, db)
    if user is None:
        raise HTTPException(401, "Session expired")
    return _session(response, user)  # rotates the refresh cookie


@router.post("/logout", status_code=204, dependencies=[Depends(require_csrf_header)])
async def logout(request: Request, db: AsyncSession = Depends(get_db)):
    user = await _user_from_refresh_cookie(request, db)
    if user is None and request.headers.get("authorization", "").lower().startswith("bearer "):
        user = await user_from_access_token(request.headers["authorization"][7:], db)
    if user is not None:
        # ponytail: revokes every session of this user; per-session revocation needs a jti store.
        user.token_version += 1
        await db.commit()
        security_log.info("logout user=%s", user.username)
    response = Response(status_code=204)
    response.delete_cookie(REFRESH_COOKIE, **_cookie_attrs())
    return response


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_active_user)):
    return _user_resp(user)


@router.post("/password", response_model=TokenResponse, dependencies=[Depends(auth_limit)])
async def change_password(data: PasswordChange, response: Response,
                          user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    """Change my own password. 400 (not 401) on a wrong current password: a 401 would trigger a refresh."""
    if not await asyncio.to_thread(verify_password, data.current_password, user.hashed_password):
        raise HTTPException(400, "Current password is incorrect")
    if data.new_password == data.current_password:
        raise HTTPException(400, "New password must differ from the current one")
    user.hashed_password = await asyncio.to_thread(hash_password, data.new_password)
    user.token_version += 1  # signs out every other session
    await db.commit()
    security_log.info("password_changed user=%s", user.username)
    return _session(response, user)  # this session continues on a fresh token and cookie


@router.post("/api-key", response_model=ApiKeyResponse)
async def rotate_api_key(user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    """Issue a new API key (the previous one stops working). The key is shown only in this response."""
    key = generate_api_key()
    user.api_key_hash = hash_api_key(key)
    await db.commit()
    security_log.info("api_key_rotated user=%s", user.username)
    return ApiKeyResponse(api_key=key)


# ── Accounts (invite-only) ────────────────────────────────────────────────


@router.get("/users", response_model=list[UserPublic])
async def list_users(_: User = Depends(require_sre_or_admin), db: AsyncSession = Depends(get_db)):
    """Active users, for picking an assignee."""
    rows = (await db.execute(
        select(User).where(User.is_active == True).order_by(User.username)  # noqa: E712
    )).scalars().all()
    return [UserPublic(id=u.id, username=u.username, role=u.role) for u in rows]


@router.get("/accounts", response_model=list[UserResponse])
async def list_accounts(_: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Every account, deactivated ones included, for the admin screen."""
    rows = (await db.execute(select(User).where(User.deleted_at.is_(None)).order_by(User.username))).scalars().all()
    return [_user_resp(u) for u in rows]


@router.post("/users", response_model=UserResponse, status_code=201)
async def create_user(data: UserCreate, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    try:
        user = await create_account(db, data, created_by=admin.username)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _user_resp(user)


@router.patch("/users/{user_id}", response_model=UserResponse)
async def update_user(user_id: str, data: UserUpdate, admin: User = Depends(require_admin),
                      db: AsyncSession = Depends(get_db)):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "User not found")
    if user.id == admin.id and (
        (data.role is not None and data.role != user.role)
        or (data.is_active is not None and data.is_active != user.is_active)
    ):
        raise HTTPException(400, "You cannot change your own role or active status")
    if data.role is not None and data.role != user.role:
        security_log.info("role_changed by=%s user=%s from=%s to=%s", admin.username, user.username, user.role, data.role)
        user.role = data.role
        user.token_version += 1  # old tokens carry the old role
    if data.is_active is not None and data.is_active != user.is_active:
        security_log.info("user_%s by=%s user=%s", "activated" if data.is_active else "deactivated",
                          admin.username, user.username)
        user.is_active = data.is_active
        user.token_version += 1
    if data.password is not None:
        user.hashed_password = await asyncio.to_thread(hash_password, data.password)
        user.token_version += 1
        security_log.info("password_reset by=%s user=%s", admin.username, user.username)
    await db.commit()
    return _user_resp(user)


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: str, admin: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Delete an account. Their history stays, shown as "Deleted user"; their active incidents become unassigned."""
    user = await db.get(User, user_id)
    if user is None or user.deleted_at is not None:
        raise HTTPException(404, "User not found")
    if user.id == admin.id:
        raise HTTPException(400, "You cannot delete your own account")
    changed = await delete_account(db, user, admin)  # commits
    for wi_id in changed:  # side effects only after the commit
        await invalidate_cache(wi_id)
        await ws_manager.broadcast({"event": "work_item_assigned", "id": wi_id})
    return Response(status_code=204)
