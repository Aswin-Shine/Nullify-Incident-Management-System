"""Data lake sink: append-only JSONL audit log of every raw signal, one file per component.

Queryable per-incident signals live in the Postgres `signals` table; this file is the immutable
audit trail (each line carries the work_item_id it was linked to, or null if persistence failed).
"""
import asyncio
import json
import os

import aiofiles

from app.core.config import get_settings

_lock = asyncio.Lock()  # ponytail: one global lock serialises all lake writes (B-15); replaced in Phase 1


def _path(component: str) -> str:
    lake_dir = get_settings().lake_dir
    os.makedirs(lake_dir, exist_ok=True)
    safe = component.replace("/", "_").replace(":", "_")
    return os.path.join(lake_dir, f"{safe}.jsonl")


async def append_signal(signal: dict):
    """Append one raw signal to its component's JSONL file."""
    path = _path(signal.get("component_id", "UNKNOWN"))
    async with _lock:
        async with aiofiles.open(path, "a") as f:
            await f.write(json.dumps(signal, default=str) + "\n")
