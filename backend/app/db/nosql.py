"""Data lake sink: append-only JSONL audit log of every raw signal, one file per component per UTC day
(`<lake_dir>/YYYY-MM-DD/<COMPONENT>.jsonl`), so retention can drop whole days.

Queryable per-incident signals live in the Postgres `signals` table; this file is the immutable
audit trail (each line carries the work_item_id it was linked to, or null if persistence failed).
"""
import asyncio
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone

from app.core.config import get_settings

# ponytail: one lock per lake file, per process. Workers in other processes rely on O_APPEND keeping
# each line (under 4 KB, the usual signal) atomic; a cross-process file lock if lines grow past that.
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_made_dirs: set[str] = set()


def _safe(component: str) -> str:
    return re.sub(r"[^A-Z0-9_.-]", "_", component.upper())[:64] or "UNKNOWN"  # allowlist, not blocklist


def _path(safe: str) -> str:
    day_dir = os.path.join(get_settings().lake_dir, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    if day_dir not in _made_dirs:
        os.makedirs(day_dir, exist_ok=True)
        _made_dirs.add(day_dir)
    return os.path.join(day_dir, f"{safe}.jsonl")


def _write(path: str, line: str) -> None:
    with open(path, "a") as f:
        f.write(line)


async def append_signal(signal: dict):
    """Append one raw signal to its component's JSONL file for today."""
    safe = _safe(signal.get("component_id", "UNKNOWN"))
    async with _locks[safe]:  # per component, not per path: the path changes daily, the lock set must not grow
        await asyncio.to_thread(_write, _path(safe), json.dumps(signal, default=str) + "\n")
