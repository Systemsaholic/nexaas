"""Worker pool that pulls jobs from the queue and executes them."""

import asyncio
import json
import logging
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

import httpx

from config import settings
from db.database import get_db
from db.usage import record_usage
from orchestrator.event_bus import publish
from orchestrator.job_queue import dequeue, complete_job
from orchestrator.session_manager import manager
from readers.agent_reader import get_agent

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

    # Look up agent's declared MCP servers for per-agent filtering
    agent_info = get_agent(agent)
    mcp_servers = agent_info["config"].get("mcp_servers", []) if agent_info else []

    session_id = manager.create_session(agent=agent, mcp_servers=mcp_servers)
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

    agent_info = get_agent(agent)
    mcp_servers = agent_info["config"].get("mcp_servers", []) if agent_info else []

    session_id = manager.create_session(agent=agent, mcp_servers=mcp_servers)
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


def _interpolate_vars(text: str, context: dict[str, Any]) -> str:
    """Replace {{var.path}} placeholders with context values.

    Supported patterns:
    - {{steps.step_id.output}} - Output from a previous step
    - {{env.VAR_NAME}} - Environment variable
    - {{date.today}} - Today's date (YYYY-MM-DD)
    - {{date.iso}} - Current ISO timestamp
    - {{date.week}} - Week number (YYYY-Wxx)
    - {{flow.id}} - Flow ID
    - {{flow.name}} - Flow name
    - {{trigger.payload.key}} - Webhook trigger payload
    """
    if not text or not isinstance(text, str):
        return text

    def replacer(match):
        path = match.group(1)
        parts = path.split(".")

        if not parts:
            return match.group(0)

        root = parts[0]

        # Environment variables
        if root == "env" and len(parts) >= 2:
            var_name = parts[1]
            return os.environ.get(var_name, "")

        # Date helpers
        if root == "date":
            now = datetime.now(timezone.utc)
            if len(parts) >= 2:
                if parts[1] == "today":
                    return now.strftime("%Y-%m-%d")
                if parts[1] == "iso":
                    return now.isoformat()
                if parts[1] == "week":
                    return now.strftime("%Y-W%W")
                if parts[1] == "plus_days" and len(parts) >= 3:
                    try:
                        days = int(parts[2])
                        return (now + timedelta(days=days)).strftime("%Y-%m-%d")
                    except ValueError:
                        pass
            return now.isoformat()

        # Step outputs
        if root == "steps" and len(parts) >= 3:
            step_id = parts[1]
            field = parts[2]
            steps = context.get("steps", {})
            step_data = steps.get(step_id, {})
            return str(step_data.get(field, ""))

        # Flow metadata
        if root == "flow" and len(parts) >= 2:
            field = parts[1]
            return str(context.get("flow", {}).get(field, ""))

        # Trigger payload
        if root == "trigger" and len(parts) >= 2:
            trigger = context.get("trigger", {})
            if parts[1] == "payload" and len(parts) >= 3:
                payload = trigger.get("payload", {})
                return str(payload.get(parts[2], ""))
            return str(trigger.get(parts[1], ""))

        # Fallback - return original
        return match.group(0)

    return re.sub(r"\{\{([^}]+)\}\}", replacer, text)


def _interpolate_config(config: Any, context: dict[str, Any]) -> Any:
    """Recursively interpolate variables in a config dict/list/string."""
    if isinstance(config, str):
        return _interpolate_vars(config, context)
    if isinstance(config, dict):
        return {k: _interpolate_config(v, context) for k, v in config.items()}
    if isinstance(config, list):
        return [_interpolate_config(item, context) for item in config]
    return config


async def _execute_flow(config: dict[str, Any]) -> str:
    """Execute a multi-step flow.

    Each step is executed sequentially. Step outputs are available
    to subsequent steps via {{steps.step_id.output}}.
    """
    flow_id = config.get("flow_id", "unknown")
    flow_name = config.get("name", flow_id)
    steps = config.get("steps", [])
    trigger_payload = config.get("trigger_payload", {})

    if not steps:
        return "error: flow has no steps"

    logger.info("Starting flow %s (%s) with %d steps", flow_id, flow_name, len(steps))

    # Context for variable interpolation
    context = {
        "flow": {"id": flow_id, "name": flow_name, "run_count": 0},
        "steps": {},
        "trigger": {"payload": trigger_payload},
    }

    results = []
    success = True
    error_message = None

    for i, step in enumerate(steps):
        step_id = step.get("id", f"step-{i}")
        action = step.get("action", "claude_chat")
        step_config = step.get("config", {})
        agent = step.get("agent")
        condition = step.get("condition") or step.get("when")
        on_error = step.get("on_error", "fail")
        retry_config = step.get("retry", {})

        # Check condition if specified
        if condition:
            if isinstance(condition, list):
                # All conditions must be truthy
                conditions_met = all(
                    _interpolate_vars(c, context).lower() not in ("", "false", "0", "skip")
                    for c in condition
                )
            else:
                interpolated = _interpolate_vars(condition, context)
                conditions_met = interpolated.lower() not in ("", "false", "0", "skip")

            if not conditions_met:
                logger.info("Flow %s: skipping step %s (condition not met)", flow_id, step_id)
                context["steps"][step_id] = {"output": "", "skipped": True}
                results.append(f"[{step_id}] SKIPPED (condition not met)")
                continue

        # Check skip_unless_error for error handler steps
        if step.get("skip_unless_error") and success:
            logger.info("Flow %s: skipping error handler %s (no error)", flow_id, step_id)
            context["steps"][step_id] = {"output": "", "skipped": True}
            continue

        # Interpolate step config with current context
        interpolated_config = _interpolate_config(step_config, context)

        # Add agent if specified at step level
        if agent and "agent" not in interpolated_config:
            interpolated_config["agent"] = agent

        logger.info("Flow %s: executing step %s (%s)", flow_id, step_id, action)

        # Get executor
        executor = EXECUTORS.get(action)
        if not executor:
            error_message = f"Unknown action type: {action}"
            results.append(f"[{step_id}] ERROR: {error_message}")
            if on_error == "continue":
                context["steps"][step_id] = {"output": "", "error": error_message}
                continue
            success = False
            break

        # Execute with retry
        max_attempts = retry_config.get("attempts", 1) if retry_config else 1
        backoff = retry_config.get("backoff", [5]) if retry_config else [5]

        step_output = None
        step_error = None

        for attempt in range(max_attempts):
            try:
                step_output = await executor(interpolated_config)

                if step_output.startswith("error"):
                    step_error = step_output
                    if attempt < max_attempts - 1:
                        wait_time = backoff[min(attempt, len(backoff) - 1)]
                        logger.info("Flow %s: step %s failed, retrying in %ds",
                                    flow_id, step_id, wait_time)
                        await asyncio.sleep(wait_time)
                        continue
                else:
                    step_error = None
                    break

            except Exception as exc:
                step_error = str(exc)
                logger.exception("Flow %s: step %s exception", flow_id, step_id)
                if attempt < max_attempts - 1:
                    wait_time = backoff[min(attempt, len(backoff) - 1)]
                    await asyncio.sleep(wait_time)
                    continue
                break

        # Store step result in context
        context["steps"][step_id] = {
            "output": step_output or "",
            "error": step_error,
        }

        if step_error:
            results.append(f"[{step_id}] ERROR: {step_error}")

            if on_error == "continue":
                continue
            elif on_error.startswith("goto:"):
                # Jump to error handler step
                target = on_error[5:]
                logger.info("Flow %s: jumping to error handler %s", flow_id, target)
                # Find target step index and continue from there
                for j, s in enumerate(steps[i+1:], i+1):
                    if s.get("id") == target:
                        # We'll process this step next iteration
                        # But we need to handle this differently...
                        # For now, mark error and let skip_unless_error handle it
                        error_message = step_error
                        success = False
                        continue
            else:
                # Default: fail
                error_message = step_error
                success = False
                break
        else:
            results.append(f"[{step_id}] OK: {(step_output or '')[:200]}")

    # Trigger chained flows
    try:
        from readers.flow_reader import trigger_chained_flows
        db = await get_db()
        await trigger_chained_flows(db, flow_id, success)
    except Exception:
        logger.exception("Failed to trigger chained flows for %s", flow_id)

    # Publish completion event
    await publish("flow.completed", {
        "flow_id": flow_id,
        "success": success,
        "steps": len(steps),
        "error": error_message,
    })

    # Build final output
    output_lines = [
        f"Flow: {flow_name} ({flow_id})",
        f"Status: {'SUCCESS' if success else 'FAILED'}",
        f"Steps: {len(results)}/{len(steps)}",
        "",
        "Results:",
    ]
    output_lines.extend(results)

    final_output = "\n".join(output_lines)

    if not success:
        return f"error: flow failed - {error_message}\n\n{final_output}"

    return final_output


EXECUTORS = {
    "claude_chat": _execute_claude_chat,
    "skill": _execute_skill,
    "script": _execute_script,
    "webhook": _execute_webhook,
    "flow": _execute_flow,
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
