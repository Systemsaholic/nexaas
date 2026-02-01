"""Workspace API endpoints."""

from fastapi import APIRouter

from readers.workspace_reader import read_workspace

router = APIRouter(prefix="/api", tags=["workspace"])


@router.get("/workspace")
async def get_workspace():
    """Return the full workspace configuration."""
    return read_workspace()
