"""Ingest throughput for one hot component (architecture review H1): queue a backlog, time the drain.

HTTP load tests (locustfile.py) stop at the per-principal ingest limit; this measures the DB write path behind it.
Run one copy per uvicorn worker at once, so they contend on the same incident row like production does:

    for i in 1 2 3 4; do docker compose exec -T backend python - 5000 BENCH_A < backend/bench_ingest.py & done; wait

Each copy prints its own rate; add them up. Writes real rows and lake lines for the given component.
"""
import asyncio
import sys
import time

from app.db.cache import init_redis
from app.services import ingestion


async def main(n: int, component: str):
    await init_redis()
    for _ in range(n):
        ingestion._queue.put_nowait({"component_id": component, "signal_type": "ERROR", "message": "bench",
                                     "severity": "HIGH", "metadata": {}, "timestamp": None})
    started = time.perf_counter()
    await ingestion.start_ingestion_workers()
    await ingestion._queue.join()
    elapsed = time.perf_counter() - started
    print(f"{n} signals in {elapsed:.2f}s = {n / elapsed:.0f} signals/s")
    await ingestion.stop_ingestion_workers(timeout=1)


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]), sys.argv[2]))
