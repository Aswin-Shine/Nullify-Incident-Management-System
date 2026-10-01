"""Data lake sink: append-only JSONL audit log of every raw signal, one file per component.

Queryable per-incident signals live in the Postgres `signals` table; this file is the immutable
audit trail (each line carries the work_item_id it was linked to, or null if persistence failed).
"""
import asyncio
import json
import os
import re
from collections import defaultdict

import aiofiles

from app.core.config import get_settings

# ponytail: one lock per lake file, per process. Workers in other processes rely on O_APPEND keeping
# each line (under 4 KB, the usual signal) atomic; a cross-process file lock if lines grow past that.
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_made_dirs: set[str] = set()


def _path(component: str) -> str:
    lake_dir = get_settings().lake_dir
    if lake_dir not in _made_dirs:
        os.makedirs(lake_dir, exist_ok=True)
        _made_dirs.add(lake_dir)
    safe = re.sub(r"[^A-Z0-9_.-]", "_", component.upper())[:64] or "UNKNOWN"  # allowlist, not blocklist
    return os.path.join(lake_dir, f"{safe}.jsonl")


async def append_signal(signal: dict):
    """Append one raw signal to its component's JSONL file."""
    path = _path(signal.get("component_id", "UNKNOWN"))
    async with _locks[path]:
        async with aiofiles.open(path, "a") as f:
            await f.write(json.dumps(signal, default=str) + "\n")
