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

# ponytail: one lock per lake file, per process. Workers in other processes rely on O_APPEND keeping each
# write() (a batch of lines) whole on a local filesystem; a cross-process file lock if the lake moves to a
# network filesystem, where O_APPEND is not atomic.
_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_made_dirs: set[str] = set()
DAY_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _safe(component: str) -> str:
    return re.sub(r"[^A-Z0-9_.-]", "_", component.upper())[:64] or "UNKNOWN"  # allowlist, not blocklist


def _path(safe: str) -> str:
    day_dir = os.path.join(get_settings().lake_dir, datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    if day_dir not in _made_dirs:
        os.makedirs(day_dir, exist_ok=True)
        _made_dirs.add(day_dir)
    return os.path.join(day_dir, f"{safe}.jsonl")


def _write(path: str, lines: str) -> None:
    with open(path, "ab", buffering=0) as f:  # unbuffered: one write() call for a whole batch of lines
        f.write(lines.encode())


async def append_signal(signal: dict):
    """Append one raw signal to its component's JSONL file for today."""
    await append_signals(signal.get("component_id", "UNKNOWN"), [signal])


async def append_signals(component: str, signals: list[dict]):
    """Append raw signals of one component to its JSONL file for today, in one write."""
    safe = _safe(component)
    lines = "".join(json.dumps(s, default=str) + "\n" for s in signals)
    async with _locks[safe]:  # per component, not per path: the path changes daily, the lock set must not grow
        await asyncio.to_thread(_write, _path(safe), lines)


def read_lake(since_day: str):
    """Yield every lake line from the day folders on or after `since_day` (YYYY-MM-DD), oldest day first."""
    root = get_settings().lake_dir
    if not os.path.isdir(root):
        return
    for day in sorted(d for d in os.listdir(root) if DAY_DIR.match(d) and d >= since_day):
        for name in sorted(os.listdir(os.path.join(root, day))):
            if not name.endswith(".jsonl"):
                continue
            with open(os.path.join(root, day, name)) as f:
                for line in f:
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass  # a line torn by a crash mid-write: nothing to recover from it
