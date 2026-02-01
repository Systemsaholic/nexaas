"""Ops monitor — health checks, self-healing, and alert escalation."""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone, timedelta

import httpx

from config import settings
from db.database import get_db
from orchestrator.event_bus import publish

logger = logging.getLogger(__name__)

_running = False
_task: asyncio.Task | None = None

# Track worker restart attempts for escalation
_worker_restart_times: list[float] = []
_engine_restart_times: list[float] = []


async def _alert(
    severity: str,
    category: str,
    message: str,
    auto_healed: bool = False,
    details: dict | None = None,
) -> None:
    """Insert alert, publish to bus, and fire webhook for critical alerts."""
    try:
        db = await get_db()
        await db.execute(
            "INSERT INTO ops_alerts (severity, category, message, auto_healed, details) "
            "VALUES (?, ?, ?, ?, ?)",
            (severity, category, message, 1 if auto_healed else 0,
             json.dumps(details) if details else None),
        )
        await db.commit()
    except Exception:
        logger.exception("Failed to persist ops alert")

    await publish("ops.alert", {
        "severity": severity,
        "category": category,
        "message": message,
        "auto_healed": auto_healed,
        "details": details,
    }, source="ops_monitor")

    if severity == "critical" and settings.OPS_WEBHOOK_URL:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(settings.OPS_WEBHOOK_URL, json={
                    "severity": severity,
                    "category": category,
                    "message": message,
                    "details": details,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
        except Exception:
            logger.exception("Failed to send ops webhook")


def _prune_timestamps(timestamps: list[float], window_s: int = 600) -> list[float]:
    """Keep only timestamps within the last window_s seconds."""
    cutoff = time.time() - window_s
    return [t for t in timestamps if t > cutoff]


async def _check_engine() -> tuple[bool, bool]:
    """Check engine health. Returns (is_running, was_healed)."""
    from orchestrator import event_engine

    if event_engine._running and event_engine._task and not event_engine._task.done():
        return True, False

    global _engine_restart_times
    _engine_restart_times = _prune_timestamps(_engine_restart_times)

    if len(_engine_restart_times) >= 3:
        await _alert("critical", "engine", "Engine restart failed repeatedly (>3 in 10min)")
        return False, False

    try:
        event_engine.start()
        _engine_restart_times.append(time.time())
        await _alert("info", "engine", "Event engine was stopped — auto-restarted", auto_healed=True)
        return True, True
    except Exception as exc:
        await _alert("critical", "engine", f"Engine restart failed: {exc}")
        return False, False


async def _check_workers() -> tuple[int, int, bool]:
    """Check worker health. Returns (total, alive, was_healed)."""
    from orchestrator import workers

    total = len(workers._tasks)
    alive = sum(1 for t in workers._tasks if not t.done())

    if workers._running and alive > 0:
        return total, alive, False

    if not workers._running:
        global _worker_restart_times
        _worker_restart_times = _prune_timestamps(_worker_restart_times)

        if len(_worker_restart_times) >= 3:
            await _alert("critical", "worker", "Worker pool restart failed repeatedly (>3 in 10min)")
            return total, alive, False

        try:
            workers.start()
            _worker_restart_times.append(time.time())
            await _alert("info", "worker", "Worker pool was stopped — auto-restarted", auto_healed=True)
            return len(workers._tasks), len(workers._tasks), True
        except Exception as exc:
            await _alert("critical", "worker", f"Worker restart failed: {exc}")
            return total, alive, False

    return total, alive, False


async def _check_db() -> bool:
    """Check DB responsiveness."""
    try:
        db = await get_db()
        cursor = await db.execute("SELECT 1")
        await cursor.fetchone()
        return True
    except Exception:
        await _alert("critical", "db", "Database is unreachable")
        return False


async def _check_stale_jobs() -> int:
    """Force-fail jobs stuck in 'running' too long. Returns count."""
    db = await get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=settings.OPS_STALE_JOB_TIMEOUT_M)).isoformat()
    cursor = await db.execute(
        "SELECT id FROM job_queue WHERE status = 'running' AND started_at < ?",
        (cutoff,),
    )
    stale = await cursor.fetchall()
    if not stale:
        return 0

    ids = [row[0] for row in stale]
    now = datetime.now(timezone.utc).isoformat()
    for job_id in ids:
        await db.execute(
            "UPDATE job_queue SET status = 'failed', error = 'Force-failed by ops monitor (stale)', "
            "completed_at = ? WHERE id = ? AND status = 'running'",
            (now, job_id),
        )
    await db.commit()
    await _alert("info", "job", f"Force-failed {len(ids)} stale job(s)", auto_healed=True,
                 details={"job_ids": ids})
    return len(ids)


async def _check_pending_jobs() -> int:
    """Count jobs stuck in 'queued' for >5 min."""
    db = await get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    cursor = await db.execute(
        "SELECT COUNT(*) FROM job_queue WHERE status = 'queued' AND queued_at < ?",
        (cutoff,),
    )
    row = await cursor.fetchone()
    return row[0] if row else 0


async def _check_failed_jobs_last_hour() -> int:
    """Count failed jobs in the last hour."""
    db = await get_db()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    cursor = await db.execute(
        "SELECT COUNT(*) FROM job_queue WHERE status = 'failed' AND completed_at > ?",
        (cutoff,),
    )
    row = await cursor.fetchone()
    count = row[0] if row else 0
    if count > settings.OPS_MAX_FAILED_JOBS_HOUR:
        await _alert("warning", "job",
                     f"High job failure rate: {count} failures in last hour (threshold: {settings.OPS_MAX_FAILED_JOBS_HOUR})",
                     details={"count": count, "threshold": settings.OPS_MAX_FAILED_JOBS_HOUR})
    return count


async def _clear_expired_locks() -> int:
    """Clear expired event locks. Returns count."""
    db = await get_db()
    now = datetime.now(timezone.utc).isoformat()
    cursor = await db.execute(
        "SELECT id FROM events WHERE lock_expires_at IS NOT NULL AND lock_expires_at < ?",
        (now,),
    )
    expired = await cursor.fetchall()
    if not expired:
        return 0

    ids = [row[0] for row in expired]
    await db.execute(
        "UPDATE events SET lock_holder = NULL, lock_expires_at = NULL "
        "WHERE lock_expires_at IS NOT NULL AND lock_expires_at < ?",
        (now,),
    )
    await db.commit()
    if len(ids) > 0:
        await _alert("info", "engine", f"Cleared {len(ids)} expired event lock(s)", auto_healed=True,
                     details={"event_ids": ids})
    return len(ids)


async def _write_snapshot(
    engine_running: bool, worker_count: int, workers_alive: int,
    pending_jobs: int, failed_jobs_last_hour: int, stale_locks: int, db_ok: bool,
) -> None:
    """Persist a health snapshot."""
    try:
        db = await get_db()
        await db.execute(
            "INSERT INTO ops_health_snapshots "
            "(engine_running, worker_count, workers_alive, pending_jobs, "
            "failed_jobs_last_hour, stale_locks, db_ok) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (1 if engine_running else 0, worker_count, workers_alive,
             pending_jobs, failed_jobs_last_hour, stale_locks, 1 if db_ok else 0),
        )
        await db.commit()
    except Exception:
        logger.exception("Failed to write health snapshot")


async def _tick() -> None:
    """Run all health checks, self-heal, and record snapshot."""
    db_ok = await _check_db()
    if not db_ok:
        return

    engine_running, _ = await _check_engine()
    worker_count, workers_alive, _ = await _check_workers()
    stale_count = await _check_stale_jobs()
    pending_jobs = await _check_pending_jobs()
    failed_last_hour = await _check_failed_jobs_last_hour()
    expired_locks = await _clear_expired_locks()

    await _write_snapshot(
        engine_running=engine_running,
        worker_count=worker_count,
        workers_alive=workers_alive,
        pending_jobs=pending_jobs,
        failed_jobs_last_hour=failed_last_hour,
        stale_locks=expired_locks,
        db_ok=db_ok,
    )


async def _loop() -> None:
    """Main ops monitor loop."""
    global _running
    logger.info("Ops monitor started (interval=%ds)", settings.OPS_MONITOR_INTERVAL_S)
    while _running:
        try:
            await _tick()
        except Exception:
            logger.exception("Ops monitor tick error")
        await asyncio.sleep(settings.OPS_MONITOR_INTERVAL_S)


def start() -> None:
    """Start the ops monitor background task."""
    global _running, _task
    if not settings.OPS_MONITOR_ENABLED:
        logger.info("Ops monitor disabled via config")
        return
    if _running:
        return
    _running = True
    _task = asyncio.get_event_loop().create_task(_loop())
    logger.info("Ops monitor task created")


async def stop() -> None:
    """Stop the ops monitor."""
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
    logger.info("Ops monitor stopped")


# Manual heal actions (called from API)

async def heal_restart_workers() -> str:
    from orchestrator import workers
    if workers._running:
        await workers.stop()
    workers.start()
    await _alert("info", "worker", "Worker pool manually restarted", details={"source": "api"})
    return "Workers restarted"


async def heal_restart_engine() -> str:
    from orchestrator import event_engine
    if event_engine._running:
        await event_engine.stop()
    event_engine.start()
    await _alert("info", "engine", "Event engine manually restarted", details={"source": "api"})
    return "Engine restarted"


async def heal_clear_locks() -> str:
    count = await _clear_expired_locks()
    return f"Cleared {count} expired lock(s)"


async def heal_fail_stale_jobs() -> str:
    count = await _check_stale_jobs()
    return f"Force-failed {count} stale job(s)"


HEAL_ACTIONS = {
    "restart_workers": heal_restart_workers,
    "restart_engine": heal_restart_engine,
    "clear_locks": heal_clear_locks,
    "fail_stale_jobs": heal_fail_stale_jobs,
}
