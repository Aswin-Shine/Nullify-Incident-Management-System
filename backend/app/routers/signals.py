"""Signal ingestion router: API-key or JWT auth, per-principal rate limit, queue backpressure."""
from __future__ import annotations
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, Depends

from app.core.rate_limit import ingest_limit
from app.db.postgres import User
from app.models.schemas import SignalPayload
from app.services import ingestion

router = APIRouter(prefix="/api/signals", tags=["signals"])

RETRY_AFTER = {"Retry-After": "1"}


def _require_accepting():
    if not ingestion.accepting():
        raise HTTPException(503, "Shutting down, retry against another instance.", headers=RETRY_AFTER)


@router.post("", status_code=202)
async def ingest_signal(
    payload: SignalPayload,
    request: Request,
    _: User = Depends(ingest_limit),
):
    _require_accepting()
    signal = payload.model_dump()
    signal["timestamp"] = signal.get("timestamp") or datetime.now(timezone.utc).isoformat()
    signal["source_ip"] = request.client.host if request.client else "unknown"

    if not await ingestion.enqueue_signal(signal):
        raise HTTPException(429, "Queue full, backpressure engaged. Retry later.", headers=RETRY_AFTER)

    # The worker announces it once the signal is saved (ingestion.process_signal).
    return {"status": "accepted", "component_id": signal["component_id"]}


@router.post("/batch", status_code=202)
async def ingest_batch(
    signals: list[SignalPayload],
    request: Request,
    _: User = Depends(ingest_limit),
):
    _require_accepting()
    if len(signals) > 500:
        raise HTTPException(400, "Batch max 500")

    source_ip = request.client.host if request.client else "unknown"
    accepted = 0
    for payload in signals:
        signal = payload.model_dump()
        signal["timestamp"] = signal.get("timestamp") or datetime.now(timezone.utc).isoformat()
        signal["source_ip"] = source_ip
        if await ingestion.enqueue_signal(signal):
            accepted += 1

    return {"accepted": accepted, "rejected": len(signals) - accepted}
