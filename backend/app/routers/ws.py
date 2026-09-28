"""WebSocket live feed.

Protocol: connect to /ws, then send {"type": "auth", "token": <access token>} within
ws_auth_timeout_seconds. The server answers {"event": "auth_ok"} and starts pushing events; anything
else closes the socket with 1008. The token travels in a message, never the URL, so it stays out of
proxy access logs. Browser origins must be in settings.allowed_origins.
"""
import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.config import get_settings
from app.core.deps import user_from_access_token
from app.db.postgres import AsyncSessionLocal, User
from app.services.ws_manager import manager

router = APIRouter(tags=["websocket"])
logger = logging.getLogger("ims.ws_router")


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

    # ponytail: an open socket outlives its token's expiry or a later logout; re-check on a timer if needed.
    await manager.register(websocket)
    await websocket.send_json({"event": "auth_ok"})
    try:
        while True:
            await websocket.receive_text()  # keep alive; clients don't send anything else
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
