"""WebSocket connection manager for live dashboard push.

Sockets are per process, but the API runs several uvicorn workers, so a broadcast is published to a
Redis pub/sub channel and every worker (this one included) delivers it to its own sockets. Without a
running listener (tests, or Redis unavailable) broadcast delivers to local sockets only.
"""
from __future__ import annotations
import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

from app.core.config import get_settings
from app.db import cache

logger = logging.getLogger("ims.ws")

RECONNECT_DELAY = 1.0
SEND_TIMEOUT = 2.0  # one stalled client must not hold up the rest of a broadcast


class ConnectionManager:
    def __init__(self):
        self._connections: list[WebSocket] = []
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._pubsub = None
        self._subscribed = False  # True only while the Redis subscription is live

    @property
    def channel(self) -> str:
        # Redis pub/sub ignores the db number, so it goes in the name: a dev server and the test
        # suite on the same Redis must not receive each other's events.
        return f"ims:ws:{get_settings().redis_db}"

    async def register(self, ws: WebSocket):
        """Add an accepted, authenticated socket to the broadcast list."""
        async with self._lock:
            self._connections.append(ws)

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self._connections = [c for c in self._connections if c is not ws]

    async def start(self):
        """Subscribe to the fan-out channel and deliver what arrives to this process's sockets."""
        self._pubsub = cache._r().pubsub()
        await self._pubsub.subscribe(self.channel)
        self._subscribed = True
        self._task = asyncio.create_task(self._listen())

    async def stop(self):
        task, self._task = self._task, None
        self._subscribed = False
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._close_pubsub()

    async def _close_pubsub(self):
        pubsub, self._pubsub = self._pubsub, None
        if pubsub:
            try:
                await pubsub.aclose()
            except Exception:
                logger.debug("pubsub close failed", exc_info=True)

    async def _listen(self):
        while True:
            try:
                async for message in self._pubsub.listen():
                    if message["type"] == "message":
                        await self._send_local(message["data"])
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("WebSocket fan-out listener lost Redis (%s); retrying", e)
            self._subscribed = False  # nobody hears a publish until we resubscribe, so broadcast delivers locally
            await asyncio.sleep(RECONNECT_DELAY)
            try:
                await self._close_pubsub()
                self._pubsub = cache._r().pubsub()
                await self._pubsub.subscribe(self.channel)
                self._subscribed = True
            except Exception as e:
                logger.warning("WebSocket fan-out resubscribe failed (%s); retrying", e)

    async def _send_local(self, payload: str):
        async with self._lock:
            conns = list(self._connections)

        async def send(ws):
            try:
                await asyncio.wait_for(ws.send_text(payload), SEND_TIMEOUT)
            except Exception:  # includes the timeout: drop sockets that error or stall
                await self.disconnect(ws)

        await asyncio.gather(*(send(ws) for ws in conns))

    async def broadcast(self, data: Any):
        payload = json.dumps(data)
        # ponytail: one publish per API request; batching server-side comes with payload events (ADR-006).
        if self._subscribed and self._task is not None and not self._task.done():
            try:
                await cache._r().publish(self.channel, payload)  # our own listener delivers it back
                return
            except Exception as e:
                logger.warning("WebSocket publish failed (%s); delivering to local sockets only", e)
        await self._send_local(payload)


manager = ConnectionManager()
