"""Signal ingestion router — rate-limited, API-key or JWT auth."""
from __future__ import annotations
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_active_user
from app.db.postgres import get_db, User
from app.models.schemas import SignalPayload
from app.services import ingestion
from app.services.ws_manager import manager

router = APIRouter(prefix="/api/signals", tags=["signals"])


@router.post("", status_code=202)
async def ingest_signal(
    payload: SignalPayload,
    request: Request,
    _: User = Depends(get_current_active_user),
):
    signal = payload.model_dump()
    signal["timestamp"] = signal.get("timestamp") or datetime.now(timezone.utc).isoformat()
    signal["source_ip"] = request.client.host if request.client else "unknown"

    accepted = await ingestion.enqueue_signal(signal)
    if not accepted:
        raise HTTPException(429, "Queue full — backpressure engaged. Retry later.")

    await manager.broadcast({"event": "signal_ingested", "component": signal["component_id"]})
    return {"status": "accepted", "component_id": signal["component_id"]}


@router.post("/batch", status_code=202)
async def ingest_batch(
    signals: list[SignalPayload],
    _: User = Depends(get_current_active_user),
):
    if len(signals) > 500:
        raise HTTPException(400, "Batch max 500")

    accepted = 0
    for payload in signals:
        signal = payload.model_dump()
        signal["timestamp"] = signal.get("timestamp") or datetime.now(timezone.utc).isoformat()
        if await ingestion.enqueue_signal(signal):
            accepted += 1

    return {"accepted": accepted, "rejected": len(signals) - accepted}