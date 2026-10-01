"""B-03: WebSocket events fan out across workers through Redis pub/sub."""
import asyncio
import json
import logging
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from app.db import cache
from app.services.ws_manager import ConnectionManager

pytestmark = [pytest.mark.asyncio, pytest.mark.usefixtures("clean_state")]

EVENT = {"event": "signal_ingested", "component": "RDBMS_PRIMARY"}


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(text)


async def eventually(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition not met in time"
        await asyncio.sleep(0.01)


async def test_event_on_one_worker_reaches_sockets_on_another():
    worker_a, worker_b = ConnectionManager(), ConnectionManager()
    on_a, on_b = FakeSocket(), FakeSocket()
    await worker_a.start()
    await worker_b.start()
    try:
        await worker_a.register(on_a)
        await worker_b.register(on_b)

        await worker_a.broadcast(EVENT)

        await eventually(lambda: on_a.sent and on_b.sent)
        await asyncio.sleep(0.1)  # a double delivery would show up by now
        assert [json.loads(m) for m in on_b.sent] == [EVENT]
        assert [json.loads(m) for m in on_a.sent] == [EVENT]  # the publisher's own sockets get it once
    finally:
        await worker_a.stop()
        await worker_b.stop()


async def test_broadcast_without_a_listener_still_reaches_local_sockets():
    manager = ConnectionManager()
    ws = FakeSocket()
    await manager.register(ws)

    await manager.broadcast(EVENT)

    assert [json.loads(m) for m in ws.sent] == [EVENT]


async def test_publish_failure_falls_back_to_local_delivery_and_never_raises(caplog):
    manager = ConnectionManager()
    ws = FakeSocket()
    await manager.start()
    try:
        await manager.register(ws)
        with patch.object(cache._r(), "publish", side_effect=ConnectionError("redis down")), \
                caplog.at_level(logging.WARNING, logger="ims.ws"):
            await manager.broadcast(EVENT)

        assert [json.loads(m) for m in ws.sent] == [EVENT]
        assert any(r.levelno == logging.WARNING for r in caplog.records)
    finally:
        await manager.stop()


async def test_channel_is_scoped_to_the_redis_db():
    """Redis pub/sub ignores the db number, so a dev server on db 0 and the test suite on db 15
    would otherwise receive each other's events."""
    db = get_settings().redis_db
    manager = ConnectionManager()
    ws = FakeSocket()
    await manager.start()
    try:
        await manager.register(ws)
        await cache._r().publish(f"ims:ws:{db + 1}", json.dumps({"event": "other_db"}))
        await cache._r().publish(f"ims:ws:{db}", json.dumps(EVENT))

        await eventually(lambda: ws.sent)
        await asyncio.sleep(0.1)
        assert [json.loads(m) for m in ws.sent] == [EVENT]
    finally:
        await manager.stop()
