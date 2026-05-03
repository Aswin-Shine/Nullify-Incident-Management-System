"""WebSocket live feed endpoint."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.ws_manager import manager
import logging

router = APIRouter(tags=["websocket"])
logger = logging.getLogger("ims.ws_router")


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep alive
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
