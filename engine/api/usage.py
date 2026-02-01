"""Token usage API endpoint — operator billing data."""

from fastapi import APIRouter, Query

from db.usage import get_usage_summary

router = APIRouter(prefix="/api", tags=["usage"])


@router.get("/usage")
async def usage_summary(
    workspace: str | None = Query(None),
    agent: str | None = Query(None),
    source: str | None = Query(None),
    since: str | None = Query(None, description="ISO datetime"),
    until: str | None = Query(None, description="ISO datetime"),
):
    """Token usage summary for billing. Filterable by workspace, agent, source, date range."""
    return await get_usage_summary(
        workspace=workspace,
        agent=agent,
        source=source,
        since=since,
        until=until,
    )
