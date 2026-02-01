"""Priority job queue backed by SQLite."""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from db.database import get_db

logger = logging.getLogger(__name__)


async def enqueue(
    action_type: str,
    action_config: dict[str, Any],
    event_id: str | None = None,
    source: str = "engine",
    priority: int = 5,
    concurrency_key: str | None = None,
) -> int:
    """Add a job to the queue. Returns the job id."""
    db = await get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = await db.execute(
        "INSERT INTO job_queue (event_id, source, priority, concurrency_key, "
        "action_type, action_config, status, queued_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
        (event_id, source, priority, concurrency_key, action_type,
         json.dumps(action_config), now),
    )
    await db.commit()
    job_id = cursor.lastrowid
    logger.info("Enqueued job %d (type=%s, event=%s)", job_id, action_type, event_id)
    return job_id


async def dequeue(worker_id: str) -> dict[str, Any] | None:
    """Claim the next available job, respecting concurrency keys.

    Returns the job dict or None if no jobs available.
    """
    db = await get_db()

    # Find running concurrency keys to exclude
    cursor = await db.execute(
        "SELECT DISTINCT concurrency_key FROM job_queue "
        "WHERE status = 'running' AND concurrency_key IS NOT NULL"
    )
    running_keys = {row[0] for row in await cursor.fetchall()}

    # Find next queued job
    cursor = await db.execute(
        "SELECT id, event_id, source, priority, concurrency_key, action_type, "
        "action_config, queued_at FROM job_queue "
        "WHERE status = 'queued' ORDER BY priority ASC, queued_at ASC"
    )
    for row in await cursor.fetchall():
        ck = row[4]  # concurrency_key
        if ck and ck in running_keys:
            continue

        # Claim it
        now = datetime.now(timezone.utc).isoformat()
        await db.execute(
            "UPDATE job_queue SET status = 'running', worker_id = ?, started_at = ? "
            "WHERE id = ? AND status = 'queued'",
            (worker_id, now, row[0]),
        )
        await db.commit()
        return {
            "id": row[0],
            "event_id": row[1],
            "source": row[2],
            "priority": row[3],
            "concurrency_key": row[4],
            "action_type": row[5],
            "action_config": json.loads(row[6]),
            "queued_at": row[7],
        }

    return None


async def complete_job(job_id: int, result: str = "success", error: str | None = None) -> None:
    """Mark a job as completed or failed."""
    db = await get_db()
    now = datetime.now(timezone.utc).isoformat()
    status = "failed" if error else "completed"
    await db.execute(
        "UPDATE job_queue SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?",
        (status, result, error, now, job_id),
    )
    await db.commit()
    logger.info("Job %d %s", job_id, status)


async def get_queue_status() -> dict[str, Any]:
    """Return summary of queue state."""
    db = await get_db()

    counts: dict[str, int] = {}
    for status in ("queued", "running", "completed", "failed"):
        cursor = await db.execute(
            "SELECT COUNT(*) FROM job_queue WHERE status = ?", (status,)
        )
        row = await cursor.fetchone()
        counts[status] = row[0]

    cursor = await db.execute(
        "SELECT id, event_id, action_type, status, queued_at, started_at, completed_at, error "
        "FROM job_queue ORDER BY id DESC LIMIT 20"
    )
    recent = [dict(row) for row in await cursor.fetchall()]

    return {"counts": counts, "recent": recent}
