"""Events API endpoints."""

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from db.database import get_db
from orchestrator.event_bus import create_sse_queue, remove_sse_queue, publish

router = APIRouter(prefix="/api", tags=["events"])


class EventCreate(BaseModel):
    id: Optional[str] = None
    type: str
    condition_type: str
    condition_expr: str
    next_eval_at: Optional[str] = None
    action_type: str
    action_config: dict
    status: str = "active"
    priority: int = 5
    concurrency_key: Optional[str] = None
    max_retries: int = 3
    retry_backoff_minutes: str = "5,15,60"
    expires_at: Optional[str] = None
    workspace: Optional[str] = None
    agent: Optional[str] = None
    client: Optional[str] = None
    description: Optional[str] = None
    metadata: Optional[dict] = None


@router.get("/events")
async def list_events(
    status: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    agent: Optional[str] = Query(None),
    limit: int = Query(100, le=500),
):
    """List events with optional filters."""
    db = await get_db()
    clauses = []
    params: list = []

    if status:
        clauses.append("status = ?")
        params.append(status)
    if type:
        clauses.append("type = ?")
        params.append(type)
    if agent:
        clauses.append("agent = ?")
        params.append(agent)

    where = " AND ".join(clauses) if clauses else "1=1"
    cursor = await db.execute(
        f"SELECT * FROM events WHERE {where} ORDER BY updated_at DESC LIMIT ?",
        params + [limit],
    )
    rows = await cursor.fetchall()
    results = []
    for row in rows:
        d = dict(row)
        for field in ("action_config", "metadata"):
            if d.get(field) and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        results.append(d)
    return results


@router.post("/events")
async def create_or_update_event(event: EventCreate):
    """Create or update an event."""
    db = await get_db()
    now = datetime.now(timezone.utc).isoformat()
    event_id = event.id or uuid.uuid4().hex

    next_eval = event.next_eval_at or now
    action_config = json.dumps(event.action_config)
    metadata = json.dumps(event.metadata) if event.metadata else None

    # Upsert
    existing = await db.execute("SELECT id FROM events WHERE id = ?", (event_id,))
    row = await existing.fetchone()

    if row:
        await db.execute(
            "UPDATE events SET type=?, condition_type=?, condition_expr=?, "
            "next_eval_at=?, action_type=?, action_config=?, status=?, priority=?, "
            "concurrency_key=?, max_retries=?, retry_backoff_minutes=?, expires_at=?, "
            "workspace=?, agent=?, client=?, description=?, metadata=?, updated_at=? "
            "WHERE id=?",
            (event.type, event.condition_type, event.condition_expr,
             next_eval, event.action_type, action_config, event.status,
             event.priority, event.concurrency_key, event.max_retries,
             event.retry_backoff_minutes, event.expires_at, event.workspace,
             event.agent, event.client, event.description, metadata, now, event_id),
        )
        action = "updated"
    else:
        await db.execute(
            "INSERT INTO events (id, type, condition_type, condition_expr, next_eval_at, "
            "action_type, action_config, status, priority, concurrency_key, max_retries, "
            "retry_backoff_minutes, expires_at, workspace, agent, client, description, "
            "metadata, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (event_id, event.type, event.condition_type, event.condition_expr,
             next_eval, event.action_type, action_config, event.status,
             event.priority, event.concurrency_key, event.max_retries,
             event.retry_backoff_minutes, event.expires_at, event.workspace,
             event.agent, event.client, event.description, metadata, now, now),
        )
        action = "created"

    await db.commit()
    await publish(f"event.{action}", {"event_id": event_id})
    return {"id": event_id, "action": action}


@router.get("/events/stream")
async def event_stream():
    """SSE endpoint streaming bus events in real-time."""
    queue = create_sse_queue()

    async def generate():
        try:
            while True:
                event = await queue.get()
                yield {"event": event["type"], "data": json.dumps(event)}
        except Exception:
            pass
        finally:
            remove_sse_queue(queue)

    return EventSourceResponse(generate())
