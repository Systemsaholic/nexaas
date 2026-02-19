"""Event engine tick loop - evaluates conditions and enqueues jobs."""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone, timedelta

from config import settings
from db.database import get_db
from orchestrator.event_bus import publish
from orchestrator.job_queue import enqueue

logger = logging.getLogger(__name__)

_running = False
_task: asyncio.Task | None = None
_instance_id = uuid.uuid4().hex[:8]

LOCK_DURATION_SECONDS = 120


async def _evaluate_condition(condition_type: str, condition_expr: str) -> bool:
    """Evaluate whether an event's condition is met."""
    now = datetime.now(timezone.utc)

    if condition_type == "cron":
        # Simplified cron: we trust next_eval_at was computed correctly.
        # If we reached this point, the event is due.
        return True

    if condition_type == "interval":
        # interval conditions are always true when next_eval_at <= now
        return True

    if condition_type == "webhook":
        # Webhook-triggered events only fire when explicitly triggered
        # via the API, not on tick. Return False here.
        return False

    if condition_type == "once":
        return True

    logger.debug("Skipping event with unhandled condition_type: %s", condition_type)
    return False


def _compute_next_eval(condition_type: str, condition_expr: str) -> str:
    """Compute the next evaluation time after a successful run."""
    now = datetime.now(timezone.utc)

    if condition_type == "interval":
        try:
            seconds = int(condition_expr)
        except ValueError:
            seconds = 300
        return (now + timedelta(seconds=seconds)).isoformat()

    if condition_type == "cron":
        # Simplified: re-eval in 60 seconds. A full cron parser can be added later.
        return (now + timedelta(seconds=60)).isoformat()

    if condition_type == "once":
        # Far future - effectively disabled after one run
        return (now + timedelta(days=36500)).isoformat()

    # Default: re-eval next tick
    return (now + timedelta(seconds=settings.ENGINE_TICK_SECONDS)).isoformat()


async def _tick() -> None:
    """Single tick: find due events, lock, evaluate, enqueue."""
    db = await get_db()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    lock_until = (now + timedelta(seconds=LOCK_DURATION_SECONDS)).isoformat()

    # Find due events that are unlocked
    cursor = await db.execute(
        "SELECT id, condition_type, condition_expr, action_type, action_config, "
        "priority, concurrency_key, consecutive_fails, max_retries, "
        "retry_backoff_minutes "
        "FROM events "
        "WHERE status = 'active' AND next_eval_at <= ? "
        "AND (lock_holder IS NULL OR lock_expires_at < ?)",
        (now_iso, now_iso),
    )
    events = await cursor.fetchall()

    for event in events:
        event_id = event[0]

        # Acquire lock
        result = await db.execute(
            "UPDATE events SET lock_holder = ?, lock_expires_at = ? "
            "WHERE id = ? AND (lock_holder IS NULL OR lock_expires_at < ?)",
            (_instance_id, lock_until, event_id, now_iso),
        )
        if result.rowcount == 0:
            continue
        await db.commit()

        try:
            condition_met = await _evaluate_condition(event[1], event[2])
            if condition_met:
                # Check retry limits
                consecutive_fails = event[7] or 0
                max_retries = event[8] or 3
                if consecutive_fails >= max_retries:
                    logger.warning("Event %s exceeded max retries, pausing", event_id)
                    await db.execute(
                        "UPDATE events SET status = 'paused', lock_holder = NULL WHERE id = ?",
                        (event_id,),
                    )
                    await db.commit()
                    await publish("event.paused", {"event_id": event_id, "reason": "max_retries"})
                    continue

                # Enqueue the job (may return None if deduplicated)
                action_config = json.loads(event[4]) if isinstance(event[4], str) else event[4]
                job_id = await enqueue(
                    action_type=event[3],
                    action_config=action_config,
                    event_id=event_id,
                    source="engine",
                    priority=event[5] or 5,
                    concurrency_key=event[6],
                )

                if job_id is None:
                    # Duplicate — release lock and move to next eval
                    await db.execute(
                        "UPDATE events SET lock_holder = NULL WHERE id = ?",
                        (event_id,),
                    )
                    await db.commit()
                    continue

                next_eval = _compute_next_eval(event[1], event[2])
                await db.execute(
                    "UPDATE events SET next_eval_at = ?, lock_holder = NULL, "
                    "updated_at = ? WHERE id = ?",
                    (next_eval, now_iso, event_id),
                )
                await db.commit()
                await publish("event.triggered", {"event_id": event_id})
            else:
                # Release lock, keep same next_eval
                await db.execute(
                    "UPDATE events SET lock_holder = NULL WHERE id = ?",
                    (event_id,),
                )
                await db.commit()

        except Exception:
            logger.exception("Error processing event %s", event_id)
            await db.execute(
                "UPDATE events SET lock_holder = NULL WHERE id = ?",
                (event_id,),
            )
            await db.commit()


async def _loop() -> None:
    """Main engine loop."""
    global _running
    logger.info("Event engine started (tick=%ds, instance=%s)",
                settings.ENGINE_TICK_SECONDS, _instance_id)
    while _running:
        try:
            await _tick()
        except Exception:
            logger.exception("Engine tick error")
        await asyncio.sleep(settings.ENGINE_TICK_SECONDS)


def start() -> None:
    """Start the event engine background task."""
    global _running, _task
    if _running:
        return
    _running = True
    _task = asyncio.get_event_loop().create_task(_loop())
    logger.info("Event engine task created")


async def stop() -> None:
    """Stop the event engine."""
    global _running, _task
    _running = False
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
    logger.info("Event engine stopped")
