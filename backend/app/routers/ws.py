"""WebSocket live feed.

Protocol: connect to /ws, then send {"type": "auth", "token": <access token>} within
ws_auth_timeout_seconds. The server answers {"event": "auth_ok"} and starts pushing events; anything
else closes the socket with 1008. The token travels in a message, never the URL, so it stays out of
proxy access logs. Browser origins must be in settings.allowed_origins.
"""
import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from app.core.config import get_settings
from app.core.deps import user_from_access_token
from app.db.postgres import AsyncSessionLocal, User
from app.services.ws_manager import manager

router = APIRouter(tags=["websocket"])
logger = logging.getLogger("ims.ws_router")

# How often an open socket re-checks its user: a logout, password change, deactivation or delete ends it within this.
WS_RECHECK_SECONDS = 60


async def still_allowed(user_id: str, token_version: int) -> bool:
    async with AsyncSessionLocal() as db:
        current = (await db.execute(
            select(User.token_version).where(User.id == user_id, User.is_active == True)  # noqa: E712
        )).scalar_one_or_none()
    return current == token_version


async def authenticate_ws(token: str) -> User | None:
    async with AsyncSessionLocal() as db:
        return await user_from_access_token(token, db)


async def _read_auth(websocket: WebSocket) -> User | None:
    """The authenticated user, or None. Raises WebSocketDisconnect if the client left first."""
    try:
        msg = await asyncio.wait_for(websocket.receive_json(), timeout=get_settings().ws_auth_timeout_seconds)
    except (asyncio.TimeoutError, ValueError):
        return None
    if not isinstance(msg, dict) or msg.get("type") != "auth" or not isinstance(msg.get("token"), str):
        return None
    return await authenticate_ws(msg["token"])


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin and origin not in get_settings().allowed_origins:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    try:
        user = await _read_auth(websocket)
    except WebSocketDisconnect:
        return  # client left before authenticating (page reload, React StrictMode remount)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # The socket outlives its 15-minute token by design; revocation (token_version, deactivation) still ends it.
    try:
        await manager.register(websocket)
        await websocket.send_json({"event": "auth_ok"})
        loop = asyncio.get_running_loop()
        next_check = loop.time() + WS_RECHECK_SECONDS
        while True:
            # The deadline is wall-clock: frames from the client must not postpone the recheck.
            try:
                await asyncio.wait_for(websocket.receive_text(), max(0.0, next_check - loop.time()))
            except asyncio.TimeoutError:
                pass
            if loop.time() >= next_check:
                next_check = loop.time() + WS_RECHECK_SECONDS
                # A broadcast that stalled already dropped this socket; otherwise ask the DB whether the user still may.
                if not manager.has(websocket) or not await still_allowed(user.id, user.token_version):
                    await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
    except WebSocketDisconnect:
        pass
    except Exception as e:  # the client vanished mid-send, or the recheck could not reach the DB: the browser reconnects
        logger.info("WebSocket ended: %s", e)
    finally:
        await manager.disconnect(websocket)
