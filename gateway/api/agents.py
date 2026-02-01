"""Agent API endpoints."""

from fastapi import APIRouter, HTTPException

from readers.agent_reader import build_agent_tree, get_agent

router = APIRouter(prefix="/api", tags=["agents"])


@router.get("/agents")
async def list_agents():
    """Return the hierarchical agent tree."""
    return build_agent_tree()


@router.get("/agents/{name}")
async def get_agent_detail(name: str):
    """Return a single agent's config and prompt."""
    agent = get_agent(name)
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{name}' not found")
    return agent
