"""Workspace API endpoints."""

from fastapi import APIRouter

from readers.workspace_reader import read_workspace, list_mcp_catalog

router = APIRouter(prefix="/api", tags=["workspace"])


@router.get("/workspace")
async def get_workspace():
    """Return the full workspace configuration."""
    return read_workspace()


@router.get("/mcp-catalog")
async def get_mcp_catalog():
    """Return the framework MCP server catalog."""
    return list_mcp_catalog()
