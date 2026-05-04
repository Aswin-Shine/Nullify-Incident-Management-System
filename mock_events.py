#!/usr/bin/env python3
"""
Mock failure scenario — simulates RDBMS outage followed by MCP cascade.
Run AFTER backend is started:  python mock_events.py
"""
import asyncio
import httpx
import json
from datetime import datetime, timezone, timedelta
import random

BASE = "http://localhost:8000"

SCENARIOS = [
    # Wave 1: RDBMS primary failure (P0)
    {
        "component_id": "RDBMS_PRIMARY",
        "signal_type": "CONNECTION_REFUSED",
        "message": "Primary PostgreSQL node unreachable — connection pool exhausted",
        "severity": "CRITICAL",
    },
    {
        "component_id": "RDBMS_PRIMARY",
        "signal_type": "TIMEOUT",
        "message": "Query timeout >30s on RDBMS_PRIMARY",
        "severity": "CRITICAL",
    },
    # Wave 2: Replica lag
    {
        "component_id": "RDBMS_REPLICA",
        "signal_type": "REPLICATION_LAG",
        "message": "Replica lag 45s — read traffic impacted",
        "severity": "HIGH",
    },
    # Wave 3: MCP cascade
    {
        "component_id": "MCP_HOST_01",
        "signal_type": "ERROR",
        "message": "MCP agent tools failing — DB dependency unavailable",
        "severity": "HIGH",
    },
    {
        "component_id": "MCP_HOST_02",
        "signal_type": "ERROR",
        "message": "MCP_HOST_02 agent orchestration degraded",
        "severity": "HIGH",
    },
    # Wave 4: Cache miss storm from DB failure
    {
        "component_id": "CACHE_CLUSTER_01",
        "signal_type": "LATENCY_SPIKE",
        "message": "Cache miss rate 94% — DB fallback failing",
        "severity": "MEDIUM",
    },
    # Wave 5: API degradation
    {
        "component_id": "API_GATEWAY",
        "signal_type": "ERROR",
        "message": "5xx rate 45% — upstream DB/MCP failures",
        "severity": "HIGH",
    },
    {
        "component_id": "API_GATEWAY",
        "signal_type": "LATENCY_SPIKE",
        "message": "p99 latency 12s — cascading from RDBMS outage",
        "severity": "HIGH",
    },
    # Wave 6: Queue backup
    {
        "component_id": "KAFKA_BROKER_01",
        "signal_type": "OOM",
        "message": "Consumer lag 500k msgs — processing stalled",
        "severity": "MEDIUM",
    },
]


async def send_signal(client: httpx.AsyncClient, signal: dict, delay: float = 0):
    if delay:
        await asyncio.sleep(delay)
    try:
        r = await client.post(f"{BASE}/api/signals", json=signal, timeout=5)
        status = "✓" if r.status_code == 202 else f"✗ {r.status_code}"
        print(f"  {status} [{signal['component_id']}] {signal['signal_type']}")
    except Exception as e:
        print(f"  ✗ {signal['component_id']}: {e}")


async def burst_signals(client: httpx.AsyncClient, component_id: str, count: int = 110):
    """Send 110 signals for same component to trigger debounce (threshold=100)."""
    print(f"\n  Burst: sending {count} signals for {component_id} (debounce test)...")
    tasks = []
    for i in range(count):
        sig = {
            "component_id": component_id,
            "signal_type": "ERROR",
            "message": f"Burst signal #{i+1} — debounce test",
            "severity": "LOW",
        }
        tasks.append(send_signal(client, sig, delay=random.uniform(0, 2)))
    await asyncio.gather(*tasks)
    print(f"  → Should have created exactly 1 Work Item for {component_id}")


async def main():
    print("=" * 60)
    print("Nullify Mock Failure Scenario")
    print("Simulating: RDBMS outage → MCP cascade")
    print("=" * 60)

    async with httpx.AsyncClient() as client:
        # Health check
        try:
            r = await client.get(f"{BASE}/health", timeout=3)
            print(f"\n✓ Backend healthy: {r.json()}\n")
        except Exception:
            print("\n✗ Backend not reachable. Start it first:\n")
            print("  cd backend && uvicorn app.main:app --reload\n")
            return

        print("Wave 1: RDBMS Primary failure...")
        for s in SCENARIOS[:2]:
            await send_signal(client, s)
            await asyncio.sleep(0.3)

        print("\nWave 2: Replica lag...")
        await send_signal(client, SCENARIOS[2])
        await asyncio.sleep(0.5)

        print("\nWave 3: MCP cascade (2s later)...")
        await asyncio.sleep(2)
        for s in SCENARIOS[3:5]:
            await send_signal(client, s)
            await asyncio.sleep(0.2)

        print("\nWave 4: Cache miss storm...")
        await send_signal(client, SCENARIOS[5])
        await asyncio.sleep(0.3)

        print("\nWave 5: API degradation...")
        for s in SCENARIOS[6:8]:
            await send_signal(client, s)
            await asyncio.sleep(0.2)

        print("\nWave 6: Queue backup...")
        await send_signal(client, SCENARIOS[8])

        print("\n" + "=" * 60)
        print("Debounce test (100+ signals → 1 Work Item)...")
        await burst_signals(client, "POSTGRES_MAIN", count=110)

        print("\n" + "=" * 60)
        print("Done. Check dashboard at http://localhost:5173")
        print("Expected: ~7 Work Items created (P0–P3 mix)")


if __name__ == "__main__":
    asyncio.run(main())
