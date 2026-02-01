"""Chat WebSocket endpoint using Claude Code sessions."""

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from config import settings
from db.database import get_db
from db.usage import record_usage
from orchestrator.session_manager import manager
from readers.agent_reader import get_agent

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
        "INSERT INTO chat_sessions (id, agent, started_at, last_message_at, session_type) "
        "VALUES (?, ?, ?, ?, 'claude_code')",
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


def _parse_stream_json(line: str) -> dict | None:
    """Parse a stream-json line from Claude Code output."""
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


@router.websocket("/api/chat")
async def chat_websocket(ws: WebSocket):
    """WebSocket chat endpoint.

    Client sends JSON: { "agent": "name", "message": "...", "session_id": "optional" }
    Server streams JSON: { "type": "chunk"|"done"|"error", "content": "...", "session_id": "..." }
    """
    await ws.accept()
    logger.info("Chat WebSocket connected")

    claude_session_id: str | None = None

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

            # Create or reuse Claude Code session
            if not claude_session_id:
                claude_session_id = manager.create_session(
                    agent=agent_name,
                    session_id=session_id,
                )

            # Stream from Claude Code
            full_response = ""
            total_input_tokens = 0
            total_output_tokens = 0
            model_used = "claude-code"

            try:
                async for line in manager.send_message(claude_session_id, message):
                    chunk = _parse_stream_json(line)
                    if not chunk:
                        continue

                    # Handle different stream-json message types
                    msg_type = chunk.get("type")

                    if msg_type == "assistant" and "message" in chunk:
                        # Extract text content from assistant message
                        msg = chunk["message"]
                        if isinstance(msg, dict):
                            for block in msg.get("content", []):
                                if isinstance(block, dict) and block.get("type") == "text":
                                    text = block.get("text", "")
                                    full_response += text
                                    await ws.send_json({
                                        "type": "chunk",
                                        "content": text,
                                        "session_id": session_id,
                                    })
                            # Parse usage from message
                            usage = msg.get("usage", {})
                            total_input_tokens += usage.get("input_tokens", 0)
                            total_output_tokens += usage.get("output_tokens", 0)
                            if msg.get("model"):
                                model_used = msg["model"]

                    elif msg_type == "content_block_delta":
                        delta = chunk.get("delta", {})
                        if delta.get("type") == "text_delta":
                            text = delta.get("text", "")
                            full_response += text
                            await ws.send_json({
                                "type": "chunk",
                                "content": text,
                                "session_id": session_id,
                            })

                    elif msg_type == "result":
                        # Final result message from Claude Code
                        result_text = chunk.get("result", "")
                        if result_text and not full_response:
                            full_response = result_text
                            await ws.send_json({
                                "type": "chunk",
                                "content": result_text,
                                "session_id": session_id,
                            })
                        # Extract usage from result
                        usage = chunk.get("usage", {})
                        total_input_tokens += usage.get("input_tokens", 0)
                        total_output_tokens += usage.get("output_tokens", 0)
                        if chunk.get("model"):
                            model_used = chunk["model"]

                # Store assistant response
                if full_response:
                    await _store_message(db, session_id, "assistant", full_response)

                # Track token usage
                if total_input_tokens or total_output_tokens:
                    await record_usage(
                        source="chat",
                        model=model_used,
                        input_tokens=total_input_tokens,
                        output_tokens=total_output_tokens,
                        workspace=None,
                        agent=agent_name,
                        session_id=session_id,
                    )

                # Update claude_session_id in DB
                await db.execute(
                    "UPDATE chat_sessions SET claude_session_id = ? WHERE id = ?",
                    (claude_session_id, session_id),
                )
                await db.commit()

                await ws.send_json({
                    "type": "done",
                    "content": full_response,
                    "session_id": session_id,
                })

            except Exception as e:
                error_msg = f"Claude Code error: {e}"
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
    finally:
        if claude_session_id:
            await manager.destroy_session(claude_session_id)
