"""WebSocket auth: first message must carry a valid access token; foreign origins are refused."""
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import update
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.config import get_settings
from app.core.security import create_access_token, create_refresh_token
from app.db.postgres import AsyncSessionLocal, User
from app.main import app
from app.routers.ws import authenticate_ws
from app.services.ws_manager import manager

# ── authenticate_ws: real tokens against the real DB ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("clean_state")
async def test_authenticate_ws_accepts_only_live_access_tokens(make_user, monkeypatch):
    user = await make_user("viewer")
    good = create_access_token({"sub": user["id"], "role": "viewer", "tv": 0})

    assert (await authenticate_ws(good)).id == user["id"]
    assert await authenticate_ws("garbage") is None
    assert await authenticate_ws(create_refresh_token({"sub": user["id"], "role": "viewer", "tv": 0})) is None

    monkeypatch.setattr(get_settings(), "jwt_access_token_expire_minutes", -1)
    assert await authenticate_ws(create_access_token({"sub": user["id"], "role": "viewer", "tv": 0})) is None

    async with AsyncSessionLocal() as db:  # logout / role change bumps the version
        await db.execute(update(User).where(User.id == user["id"]).values(token_version=1))
        await db.commit()
    assert await authenticate_ws(good) is None


# ── protocol: sync TestClient, authentication patched out (no DB) ─────────────


@pytest.fixture
def ws_client(monkeypatch):
    monkeypatch.setattr(get_settings(), "ws_auth_timeout_seconds", 0.2)
    return TestClient(app)  # no `with`: lifespan (Redis, workers) is not started


def test_ws_without_auth_message_is_closed(ws_client):
    """Regression for S-03: anyone could open /ws and receive every incident event."""
    with ws_client.websocket_connect("/ws") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1008


def test_ws_with_bad_token_is_closed(ws_client):
    with patch("app.routers.ws.authenticate_ws", new_callable=AsyncMock, return_value=None):
        with ws_client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "auth", "token": "bad"})
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
    assert closed.value.code == 1008


def test_ws_with_good_token_is_registered_for_broadcasts(ws_client):
    with patch("app.routers.ws.authenticate_ws", new_callable=AsyncMock, return_value=object()):
        with ws_client.websocket_connect("/ws") as ws:
            assert manager_size() == 0
            ws.send_json({"type": "auth", "token": "good"})
            assert ws.receive_json() == {"event": "auth_ok"}
            assert manager_size() == 1


class _SocketThatLeaves:
    """A client that disconnects before sending its auth message."""
    headers: dict = {}

    def __init__(self):
        self.closed_with = []

    async def accept(self):
        pass

    async def receive_json(self):
        raise WebSocketDisconnect(code=1001)

    async def close(self, code=1000):
        self.closed_with.append(code)


@pytest.mark.asyncio
async def test_client_leaving_before_auth_is_not_closed_again():
    """Found in the browser check: StrictMode/reloads drop the socket before it authenticates, and
    the server then closed an already-closed socket (uvicorn: RuntimeError in the ASGI app).
    Starlette's TestClient ignores that double close, so this drives the endpoint directly."""
    from app.routers.ws import websocket_endpoint

    ws = _SocketThatLeaves()
    await websocket_endpoint(ws)

    assert ws.closed_with == []


def test_ws_from_foreign_origin_is_refused(ws_client):
    with pytest.raises(WebSocketDisconnect) as closed:
        with ws_client.websocket_connect("/ws", headers={"origin": "https://evil.example"}):
            pass
    assert closed.value.code == 1008


def manager_size():
    return len(manager._connections)
