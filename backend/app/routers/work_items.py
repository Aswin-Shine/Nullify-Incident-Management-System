"""Work Items router — full CRUD + comments + RCA + analytics."""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_active_user, require_sre_or_admin
from app.db.postgres import get_db, User
from app.db.nosql import get_signals_for_component
from app.models.schemas import StatusTransition, RCASubmit, CommentCreate, AssignRequest
from app.services import work_item_service
from app.services.state_machine import InvalidTransitionError
from app.services.ws_manager import manager
from app.services import webhooks

router = APIRouter(prefix="/api/work-items", tags=["work-items"])


@router.get("")
async def list_work_items(
    status: str | None = None,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    items = await work_item_service.list_work_items(db, status)
    return [i.model_dump(mode="json") for i in items]


@router.get("/analytics/mttr")
async def mttr_stats(
    component: str | None = None,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    return await work_item_service.get_mttr_stats(db, component)


@router.get("/analytics/sla")
async def sla_stats(
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    return await work_item_service.get_sla_stats(db)


@router.get("/{wi_id}")
async def get_work_item(
    wi_id: str,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    item = await work_item_service.get_work_item(wi_id, db)
    if not item:
        raise HTTPException(404, "Work item not found")
    return item.model_dump(mode="json")


@router.get("/{wi_id}/signals")
async def get_signals(
    wi_id: str,
    limit: int = 200,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    item = await work_item_service.get_work_item(wi_id, db)
    if not item:
        raise HTTPException(404, "Work item not found")
    signals = await get_signals_for_component(item.component)
    return signals[-limit:]


@router.patch("/{wi_id}/status")
async def update_status(
    wi_id: str,
    body: StatusTransition,
    user: User = Depends(require_sre_or_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        updated = await work_item_service.transition_status(wi_id, body.new_status, db)
    except InvalidTransitionError as e:
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))

    data = updated.model_dump(mode="json")
    await manager.broadcast({"event": "work_item_updated", "id": wi_id, "status": body.new_status})
    await webhooks.notify_status_change(data, body.new_status)
    return data


@router.patch("/{wi_id}/assign")
async def assign(
    wi_id: str,
    body: AssignRequest,
    user: User = Depends(require_sre_or_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        updated = await work_item_service.assign_work_item(wi_id, body.assignee_id, db)
    except ValueError as e:
        raise HTTPException(422, str(e))
    await manager.broadcast({"event": "work_item_assigned", "id": wi_id})
    return updated.model_dump(mode="json")


#@router.post("/{wi_id}/rca")
# async def submit_rca(
#     wi_id: str,
#     body: RCASubmit,
#     user: User = Depends(require_sre_or_admin),
#     db: AsyncSession = Depends(get_db),
# ):
#     try:
#         rca = await work_item_service.submit_rca(wi_id, body, db, user.id)
#     except ValueError as e:
#         raise HTTPException(422, str(e))
#     await manager.broadcast({"event": "rca_submitted", "id": wi_id})
#     return rca.model_dump(mode="json")

@router.post("/{wi_id}/rca", response_model=None) # Added response_model=None
async def submit_rca(
    wi_id: str,
    body: RCASubmit,
    user: User = Depends(require_sre_or_admin),
    db: AsyncSession = Depends(get_db),
):
    try:
        rca = await work_item_service.submit_rca(wi_id, body, db, user.id)
        # Ensure we return a dictionary or a Pydantic-compatible object
        return rca.model_dump(mode="json") 
    except ValueError as e:
        raise HTTPException(422, str(e))


@router.get("/{wi_id}/rca")
async def get_rca(
    wi_id: str,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    rca = await work_item_service.get_rca(wi_id, db)
    if not rca:
        raise HTTPException(404, "No RCA found")
    return rca.model_dump(mode="json")


@router.post("/{wi_id}/comments", status_code=201)
async def add_comment(
    wi_id: str,
    body: CommentCreate,
    user: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        comment = await work_item_service.add_comment(wi_id, body, user.id, db)
    except ValueError as e:
        raise HTTPException(422, str(e))
    await manager.broadcast({"event": "comment_added", "id": wi_id})
    return comment.model_dump(mode="json")


@router.get("/{wi_id}/comments")
async def list_comments(
    wi_id: str,
    _: User = Depends(get_current_active_user),
    db: AsyncSession = Depends(get_db),
):
    return [c.model_dump(mode="json") for c in await work_item_service.list_comments(wi_id, db)]