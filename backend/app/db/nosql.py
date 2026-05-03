"""JSON-file NoSQL sink — raw signal audit log (data lake)."""
import asyncio
import aiofiles
import json
import os
from datetime import datetime

LAKE_DIR = os.environ.get("IMS_LAKE_DIR", "datalake")
_lock = asyncio.Lock()


def _path(component: str) -> str:
    os.makedirs(LAKE_DIR, exist_ok=True)
    safe = component.replace("/", "_").replace(":", "_")
    return os.path.join(LAKE_DIR, f"{safe}.jsonl")


async def append_signal(signal: dict):
    """Append raw signal to component JSONL file (async, locked per component)."""
    path = _path(signal.get("component_id", "UNKNOWN"))
    async with _lock:
        async with aiofiles.open(path, "a") as f:
            await f.write(json.dumps(signal) + "\n")


async def get_signals_for_component(component_id: str, limit: int = 200) -> list[dict]:
    path = _path(component_id)
    if not os.path.exists(path):
        return []
    signals = []
    async with aiofiles.open(path, "r") as f:
        async for line in f:
            line = line.strip()
            if line:
                try:
                    signals.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return signals[-limit:]
