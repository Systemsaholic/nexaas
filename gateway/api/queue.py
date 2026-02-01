"""Job queue API endpoints."""

from fastapi import APIRouter

from engine.job_queue import get_queue_status

router = APIRouter(prefix="/api", tags=["queue"])


@router.get("/queue")
async def queue_status():
    """Return job queue status with counts and recent jobs."""
    return await get_queue_status()
