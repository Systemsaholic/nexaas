"""In-process pub/sub event bus with persistence and SSE support."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine

from db.database import get_db

logger = logging.getLogger(__name__)

SubscriberCallback = Callable[[str, dict[str, Any]], Coroutine[Any, Any, None]]

_subscribers: dict[str, list[SubscriberCallback]] = {}
_sse_queues: list[asyncio.Queue] = []


def subscribe(event_type: str, callback: SubscriberCallback) -> None:
    """Register a callback for a given event type."""
    _subscribers.setdefault(event_type, []).append(callback)
    logger.debug("Subscribed to '%s'", event_type)


def unsubscribe(event_type: str, callback: SubscriberCallback) -> None:
    """Remove a callback subscription."""
    if event_type in _subscribers:
        _subscribers[event_type] = [
            cb for cb in _subscribers[event_type] if cb is not callback
        ]


async def publish(event_type: str, data: dict[str, Any], source: str | None = None) -> None:
    """Publish an event to all subscribers and persist it."""
    now = datetime.now(timezone.utc).isoformat()

    # Persist to bus_events table
    try:
        db = await get_db()
        await db.execute(
            "INSERT INTO bus_events (type, source, data, created_at) VALUES (?, ?, ?, ?)",
            (event_type, source, json.dumps(data), now),
        )
        await db.commit()
    except Exception:
        logger.exception("Failed to persist bus event")

    # Notify in-process subscribers
    callbacks = _subscribers.get(event_type, []) + _subscribers.get("*", [])
    for callback in callbacks:
        try:
            await callback(event_type, data)
        except Exception:
            logger.exception("Error in subscriber callback for '%s'", event_type)

    # Push to SSE queues
    sse_payload = {"type": event_type, "source": source, "data": data, "created_at": now}
    for queue in list(_sse_queues):
        try:
            queue.put_nowait(sse_payload)
        except asyncio.QueueFull:
            logger.warning("SSE queue full, dropping event")


def create_sse_queue() -> asyncio.Queue:
    """Create a new SSE subscriber queue."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    _sse_queues.append(queue)
    return queue


def remove_sse_queue(queue: asyncio.Queue) -> None:
    """Remove an SSE subscriber queue."""
    if queue in _sse_queues:
        _sse_queues.remove(queue)
