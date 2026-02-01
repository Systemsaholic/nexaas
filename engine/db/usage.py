"""Token usage tracking for billing."""

import logging
from datetime import datetime, timezone

from db.database import get_db

logger = logging.getLogger(__name__)

# Pricing per 1M tokens (as of 2025 — update as needed)
MODEL_PRICING = {
    "claude-sonnet-4-20250514": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_create": 3.75},
    "claude-opus-4-20250514":   {"input": 15.00, "output": 75.00, "cache_read": 1.50, "cache_create": 18.75},
    "claude-haiku-3-20250414":  {"input": 0.25, "output": 1.25, "cache_read": 0.025, "cache_create": 0.30},
}

DEFAULT_PRICING = {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_create": 3.75}


def estimate_cost(model: str, input_tokens: int, output_tokens: int,
                  cache_read: int = 0, cache_create: int = 0) -> float:
    pricing = MODEL_PRICING.get(model, DEFAULT_PRICING)
    cost = (
        (input_tokens / 1_000_000) * pricing["input"]
        + (output_tokens / 1_000_000) * pricing["output"]
        + (cache_read / 1_000_000) * pricing["cache_read"]
        + (cache_create / 1_000_000) * pricing["cache_create"]
    )
    return round(cost, 6)


async def record_usage(
    *,
    source: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    workspace: str | None = None,
    agent: str | None = None,
    session_id: str | None = None,
) -> None:
    """Record a Claude API call's token usage."""
    cost = estimate_cost(model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    now = datetime.now(timezone.utc).isoformat()

    db = await get_db()
    await db.execute(
        "INSERT INTO token_usage "
        "(workspace, agent, session_id, source, model, input_tokens, output_tokens, "
        "cache_read_tokens, cache_creation_tokens, cost_usd, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (workspace, agent, session_id, source, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost, now),
    )
    await db.commit()

    logger.debug(
        "Token usage: %s/%s model=%s in=%d out=%d cost=$%.4f",
        source, agent or "-", model, input_tokens, output_tokens, cost,
    )


async def get_usage_summary(
    workspace: str | None = None,
    agent: str | None = None,
    source: str | None = None,
    since: str | None = None,
    until: str | None = None,
) -> dict:
    """Get aggregated usage stats with optional filters."""
    db = await get_db()

    conditions = []
    params = []
    if workspace:
        conditions.append("workspace = ?")
        params.append(workspace)
    if agent:
        conditions.append("agent = ?")
        params.append(agent)
    if source:
        conditions.append("source = ?")
        params.append(source)
    if since:
        conditions.append("created_at >= ?")
        params.append(since)
    if until:
        conditions.append("created_at <= ?")
        params.append(until)

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    # Totals
    cursor = await db.execute(
        f"SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), "
        f"COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_creation_tokens),0), "
        f"COALESCE(SUM(cost_usd),0) FROM token_usage{where}",
        params,
    )
    row = await cursor.fetchone()

    # By model
    cursor2 = await db.execute(
        f"SELECT model, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) "
        f"FROM token_usage{where} GROUP BY model ORDER BY SUM(cost_usd) DESC",
        params,
    )
    by_model = [
        {"model": r[0], "calls": r[1], "input_tokens": r[2], "output_tokens": r[3], "cost_usd": round(r[4], 4)}
        for r in await cursor2.fetchall()
    ]

    # By agent
    cursor3 = await db.execute(
        f"SELECT agent, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) "
        f"FROM token_usage{where} GROUP BY agent ORDER BY SUM(cost_usd) DESC",
        params,
    )
    by_agent = [
        {"agent": r[0] or "(system)", "calls": r[1], "input_tokens": r[2], "output_tokens": r[3], "cost_usd": round(r[4], 4)}
        for r in await cursor3.fetchall()
    ]

    # By source
    cursor4 = await db.execute(
        f"SELECT source, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) "
        f"FROM token_usage{where} GROUP BY source ORDER BY SUM(cost_usd) DESC",
        params,
    )
    by_source = [
        {"source": r[0], "calls": r[1], "input_tokens": r[2], "output_tokens": r[3], "cost_usd": round(r[4], 4)}
        for r in await cursor4.fetchall()
    ]

    # Daily breakdown
    cursor5 = await db.execute(
        f"SELECT DATE(created_at) as day, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd) "
        f"FROM token_usage{where} GROUP BY day ORDER BY day DESC LIMIT 30",
        params,
    )
    daily = [
        {"date": r[0], "calls": r[1], "input_tokens": r[2], "output_tokens": r[3], "cost_usd": round(r[4], 4)}
        for r in await cursor5.fetchall()
    ]

    return {
        "total_calls": row[0],
        "total_input_tokens": row[1],
        "total_output_tokens": row[2],
        "total_cache_read_tokens": row[3],
        "total_cache_creation_tokens": row[4],
        "total_cost_usd": round(row[5], 4),
        "by_model": by_model,
        "by_agent": by_agent,
        "by_source": by_source,
        "daily": daily,
    }
