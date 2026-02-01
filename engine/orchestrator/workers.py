"""Worker pool that pulls jobs from the queue and executes them."""

import asyncio
import json
import logging
import subprocess
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx

from config import settings
from db.database import get_db
from db.usage import record_usage
from orchestrator.event_bus import publish
from orchestrator.job_queue import dequeue, complete_job
from orchestrator.session_manager import manager

logger = logging.getLogger(__name__)

_running = False
_tasks: list[asyncio.Task] = []


async def _execute_claude_chat(config: dict[str, Any]) -> str:
    """Execute a Claude Code chat action."""
    agent = config.get("agent", "default")
    prompt = config.get("prompt", "")
    messages = config.get("messages", [])

    if not prompt and messages:
        # Combine messages into a single prompt
        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                parts.insert(0, f"[System]: {content}")
            else:
                parts.append(content)
        prompt = "\n\n".join(parts)

    if not prompt:
        return "error: no prompt or messages provided"

    session_id = manager.create_session(agent=agent)
    try:
        output_parts = []
        total_input_tokens = 0
        total_output_tokens = 0
        model_used = "claude-code"

        async for line in manager.send_message(session_id, prompt):
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue

            msg_type = chunk.get("type")

            if msg_type == "assistant" and "message" in chunk:
                msg = chunk["message"]
                if isinstance(msg, dict):
                    for block in msg.get("content", []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            output_parts.append(block.get("text", ""))
                    usage = msg.get("usage", {})
                    total_input_tokens += usage.get("input_tokens", 0)
                    total_output_tokens += usage.get("output_tokens", 0)
                    if msg.get("model"):
                        model_used = msg["model"]

            elif msg_type == "result":
                result_text = chunk.get("result", "")
                if result_text and not output_parts:
                    output_parts.append(result_text)
                usage = chunk.get("usage", {})
                total_input_tokens += usage.get("input_tokens", 0)
                total_output_tokens += usage.get("output_tokens", 0)
                if chunk.get("model"):
                    model_used = chunk["model"]

        # Track usage
        if total_input_tokens or total_output_tokens:
            await record_usage(
                source="event_engine",
                model=model_used,
                input_tokens=total_input_tokens,
                output_tokens=total_output_tokens,
                agent=agent,
            )

        return "".join(output_parts)
    finally:
        await manager.destroy_session(session_id)


async def _execute_skill(config: dict[str, Any]) -> str:
    """Execute a skill via Claude Code session."""
    skill_name = config.get("skill", "")
    if not skill_name:
        return "error: no skill name specified"

    agent = config.get("agent", "default")
    prompt = f"Execute the skill: {skill_name}"
    if config.get("input"):
        prompt += f"\n\nInput: {config['input']}"

    session_id = manager.create_session(agent=agent)
    try:
        output_parts = []
        async for line in manager.send_message(session_id, prompt):
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if chunk.get("type") == "result":
                result_text = chunk.get("result", "")
                if result_text:
                    output_parts.append(result_text)
            elif chunk.get("type") == "assistant" and "message" in chunk:
                msg = chunk["message"]
                if isinstance(msg, dict):
                    for block in msg.get("content", []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            output_parts.append(block.get("text", ""))

        return "".join(output_parts) or "Skill executed (no output)"
    finally:
        await manager.destroy_session(session_id)


async def _execute_script(config: dict[str, Any]) -> str:
    """Execute a subprocess script action."""
    command = config.get("command", "")
    if not command:
        return "error: no command specified"

    timeout = config.get("timeout", 60)
    cwd = config.get("cwd", str(settings.workspace_path))

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        output = stdout.decode() if stdout else ""
        if proc.returncode != 0:
            err = stderr.decode() if stderr else ""
            return f"error (exit {proc.returncode}): {err}\n{output}"
        return output
    except asyncio.TimeoutError:
        proc.kill()
        return f"error: command timed out after {timeout}s"


async def _execute_webhook(config: dict[str, Any]) -> str:
    """Execute an HTTP webhook action."""
    url = config.get("url", "")
    if not url:
        return "error: no URL specified"

    method = config.get("method", "POST").upper()
    headers = config.get("headers", {})
    body = config.get("body", {})
    timeout = config.get("timeout", 30)

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(method, url, json=body, headers=headers)
        return f"status={response.status_code} body={response.text[:2000]}"


EXECUTORS = {
    "claude_chat": _execute_claude_chat,
    "skill": _execute_skill,
    "script": _execute_script,
    "webhook": _execute_webhook,
}


async def _record_run(
    event_id: str | None, worker_id: str, started: float,
    result: str, output: str, error: str | None,
) -> None:
    """Record a run in event_runs and update the event."""
    db = await get_db()
    now = datetime.now(timezone.utc)
    duration_ms = int((time.time() - started) * 1000)

    await db.execute(
        "INSERT INTO event_runs (event_id, started_at, completed_at, result, output, "
        "duration_ms, error, worker_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (event_id, datetime.fromtimestamp(started, tz=timezone.utc).isoformat(),
         now.isoformat(), result, output[:10000] if output else None,
         duration_ms, error, worker_id),
    )

    if event_id:
        if error:
            await db.execute(
                "UPDATE events SET last_run_at = ?, last_result = ?, last_output = ?, "
                "run_count = run_count + 1, fail_count = fail_count + 1, "
                "consecutive_fails = consecutive_fails + 1, updated_at = ? WHERE id = ?",
                (now.isoformat(), "failed", error[:2000], now.isoformat(), event_id),
            )
        else:
            await db.execute(
                "UPDATE events SET last_run_at = ?, last_result = ?, last_output = ?, "
                "run_count = run_count + 1, consecutive_fails = 0, updated_at = ? WHERE id = ?",
                (now.isoformat(), "success", output[:2000] if output else None,
                 now.isoformat(), event_id),
            )
    await db.commit()


async def _worker(worker_id: str) -> None:
    """Single worker loop: dequeue and execute jobs."""
    logger.info("Worker %s started", worker_id)
    while _running:
        job = await dequeue(worker_id)
        if job is None:
            await asyncio.sleep(2)
            continue

        job_id = job["id"]
        action_type = job["action_type"]
        logger.info("Worker %s processing job %d (type=%s)", worker_id, job_id, action_type)

        executor = EXECUTORS.get(action_type)
        if not executor:
            error = f"Unknown action_type: {action_type}"
            await complete_job(job_id, result="failed", error=error)
            await _record_run(job["event_id"], worker_id, time.time(), "failed", "", error)
            continue

        started = time.time()
        try:
            output = await executor(job["action_config"])
            error_msg = None
            if output.startswith("error"):
                error_msg = output
                await complete_job(job_id, result="failed", error=error_msg)
            else:
                await complete_job(job_id, result="success")

            await _record_run(job["event_id"], worker_id, started,
                              "failed" if error_msg else "success", output, error_msg)
            await publish("job.completed", {
                "job_id": job_id, "event_id": job["event_id"],
                "result": "failed" if error_msg else "success",
            })

        except Exception as exc:
            error_str = str(exc)
            logger.exception("Worker %s job %d failed", worker_id, job_id)
            await complete_job(job_id, result="failed", error=error_str)
            await _record_run(job["event_id"], worker_id, started, "failed", "", error_str)
            await publish("job.failed", {
                "job_id": job_id, "event_id": job["event_id"], "error": error_str,
            })


def start() -> None:
    """Start the worker pool."""
    global _running
    if _running:
        return
    _running = True
    loop = asyncio.get_event_loop()
    for i in range(settings.WORKER_POOL_SIZE):
        worker_id = f"worker-{i}-{uuid.uuid4().hex[:4]}"
        task = loop.create_task(_worker(worker_id))
        _tasks.append(task)
    logger.info("Started %d workers", settings.WORKER_POOL_SIZE)


async def stop() -> None:
    """Stop all workers."""
    global _running
    _running = False
    for task in _tasks:
        task.cancel()
    await asyncio.gather(*_tasks, return_exceptions=True)
    _tasks.clear()
    logger.info("All workers stopped")
