"""Chat WebSocket endpoint with Claude API proxy."""

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from config import settings
from db.database import get_db
from db.usage import record_usage
from readers.agent_reader import get_agent
from readers.workspace_reader import read_workspace

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


async def _get_or_create_session(
    db, session_id: str | None, agent_name: str
) -> str:
    """Get existing session or create a new one."""
    if session_id:
        cursor = await db.execute(
            "SELECT id FROM chat_sessions WHERE id = ?", (session_id,)
        )
        if await cursor.fetchone():
            now = datetime.now(timezone.utc).isoformat()
            await db.execute(
                "UPDATE chat_sessions SET last_message_at = ? WHERE id = ?",
                (now, session_id),
            )
            await db.commit()
            return session_id

    new_id = session_id or uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO chat_sessions (id, agent, started_at, last_message_at) "
        "VALUES (?, ?, ?, ?)",
        (new_id, agent_name, now, now),
    )
    await db.commit()
    return new_id


async def _store_message(
    db, session_id: str, role: str, content: str, tool_calls: str | None = None
) -> None:
    """Store a chat message."""
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO chat_messages (session_id, role, content, tool_calls, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (session_id, role, content, tool_calls, now),
    )
    await db.commit()


async def _load_history(db, session_id: str, limit: int = 50) -> list[dict]:
    """Load recent chat history for context."""
    cursor = await db.execute(
        "SELECT role, content FROM chat_messages "
        "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, limit),
    )
    rows = await cursor.fetchall()
    return [{"role": row[0], "content": row[1]} for row in reversed(rows)]


def _build_system_prompt(agent_config: dict | None) -> str:
    """Build a system prompt from workspace and agent context."""
    parts = []

    workspace = read_workspace()
    if workspace.get("claude_md"):
        parts.append(workspace["claude_md"])

    if agent_config:
        if agent_config.get("prompt"):
            parts.append(agent_config["prompt"])
        config = agent_config.get("config", {})
        if config.get("system_prompt"):
            parts.append(config["system_prompt"])

    return "\n\n---\n\n".join(parts) if parts else "You are a helpful assistant."


@router.websocket("/api/chat")
async def chat_websocket(ws: WebSocket):
    """WebSocket chat endpoint.

    Client sends JSON: { "agent": "name", "message": "...", "session_id": "optional" }
    Server streams JSON: { "type": "chunk"|"done"|"error", "content": "...", "session_id": "..." }
    """
    await ws.accept()
    logger.info("Chat WebSocket connected")

    try:
        import anthropic
    except ImportError:
        await ws.send_json({"type": "error", "content": "anthropic package not installed"})
        await ws.close()
        return

    api_key = settings.CLAUDE_API_KEY
    if not api_key:
        await ws.send_json({"type": "error", "content": "CLAUDE_API_KEY not configured"})
        await ws.close()
        return

    client = anthropic.AsyncAnthropic(api_key=api_key)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "content": "Invalid JSON"})
                continue

            agent_name = data.get("agent", "default")
            message = data.get("message", "")
            session_id = data.get("session_id")

            if not message:
                await ws.send_json({"type": "error", "content": "Empty message"})
                continue

            db = await get_db()
            session_id = await _get_or_create_session(db, session_id, agent_name)

            # Store user message
            await _store_message(db, session_id, "user", message)

            # Build context
            agent_config = get_agent(agent_name)
            system_prompt = _build_system_prompt(agent_config)
            history = await _load_history(db, session_id)

            # Ensure current message is in history
            if not history or history[-1].get("content") != message:
                history.append({"role": "user", "content": message})

            # Stream from Claude
            full_response = ""
            try:
                async with client.messages.stream(
                    model=data.get("model", "claude-sonnet-4-20250514"),
                    max_tokens=data.get("max_tokens", 4096),
                    system=system_prompt,
                    messages=history,
                ) as stream:
                    async for text in stream.text_stream:
                        full_response += text
                        await ws.send_json({
                            "type": "chunk",
                            "content": text,
                            "session_id": session_id,
                        })

                # Store assistant response
                await _store_message(db, session_id, "assistant", full_response)

                # Track token usage
                final_message = await stream.get_final_message()
                usage = final_message.usage
                model_used = data.get("model", "claude-sonnet-4-20250514")
                await record_usage(
                    source="chat",
                    model=model_used,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                    cache_creation_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
                    workspace=None,
                    agent=agent_name,
                    session_id=session_id,
                )

                await ws.send_json({
                    "type": "done",
                    "content": full_response,
                    "session_id": session_id,
                })

            except anthropic.APIError as e:
                error_msg = f"Claude API error: {e.message}"
                logger.error(error_msg)
                await ws.send_json({
                    "type": "error",
                    "content": error_msg,
                    "session_id": session_id,
                })

    except WebSocketDisconnect:
        logger.info("Chat WebSocket disconnected")
    except Exception:
        logger.exception("Chat WebSocket error")
        try:
            await ws.close()
        except Exception:
            pass
