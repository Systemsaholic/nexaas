"""Flow API endpoints."""

import json
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import settings
from db.database import get_db
from orchestrator.job_queue import enqueue
from readers.flow_reader import get_flow_config, sync_flows_to_events

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/flows", tags=["flows"])


class TriggerPayload(BaseModel):
    """Optional payload for webhook-triggered flows."""
    payload: dict[str, Any] = {}


@router.get("")
async def list_flows():
    """List all flows."""
    db = await get_db()
    cursor = await db.execute(
        "SELECT id, description, condition_type, condition_expr, status, "
        "last_run_at, last_result, run_count, metadata "
        "FROM events WHERE type = 'flow' ORDER BY id"
    )
    rows = await cursor.fetchall()

    flows = []
    for row in rows:
        metadata = json.loads(row[8]) if row[8] else {}
        flows.append({
            "id": row[0].replace("flow-", ""),  # Remove prefix
            "name": metadata.get("flow_name", row[0]),
            "description": row[1],
            "trigger_type": row[2],
            "trigger_expr": row[3],
            "status": row[4],
            "last_run_at": row[5],
            "last_result": row[6],
            "run_count": row[7],
            "step_count": metadata.get("step_count", 0),
        })

    return {"flows": flows}


@router.get("/{flow_id}")
async def get_flow(flow_id: str):
    """Get flow details."""
    db = await get_db()
    config = await get_flow_config(db, flow_id)

    if not config:
        raise HTTPException(status_code=404, detail="Flow not found")

    # Get event info
    cursor = await db.execute(
        "SELECT status, last_run_at, last_result, run_count, fail_count "
        "FROM events WHERE id = ?",
        (f"flow-{flow_id}",)
    )
    row = await cursor.fetchone()

    return {
        "id": flow_id,
        "name": config.get("name", flow_id),
        "steps": config.get("steps", []),
        "trigger": config.get("trigger", {}),
        "output": config.get("output", {}),
        "requires": config.get("requires", {}),
        "status": row[0] if row else "unknown",
        "last_run_at": row[1] if row else None,
        "last_result": row[2] if row else None,
        "run_count": row[3] if row else 0,
        "fail_count": row[4] if row else 0,
    }


@router.get("/{flow_id}/validate")
async def validate_flow(flow_id: str):
    """Validate flow configuration and dependencies."""
    db = await get_db()
    config = await get_flow_config(db, flow_id)

    if not config:
        raise HTTPException(status_code=404, detail="Flow not found")

    issues = []
    warnings = []

    # Check steps
    steps = config.get("steps", [])
    if not steps:
        issues.append("Flow has no steps")

    step_ids = set()
    for i, step in enumerate(steps):
        step_id = step.get("id", f"step-{i}")

        # Check for duplicate IDs
        if step_id in step_ids:
            issues.append(f"Duplicate step ID: {step_id}")
        step_ids.add(step_id)

        # Check action type
        action = step.get("action", "claude_chat")
        valid_actions = ["claude_chat", "skill", "script", "webhook", "flow"]
        if action not in valid_actions:
            issues.append(f"Step {step_id}: unknown action type '{action}'")

        # Check config
        step_config = step.get("config", {})
        if action == "claude_chat" and not step_config.get("prompt"):
            warnings.append(f"Step {step_id}: claude_chat has no prompt")
        if action == "webhook" and not step_config.get("url"):
            issues.append(f"Step {step_id}: webhook has no URL")
        if action == "script" and not step_config.get("command"):
            issues.append(f"Step {step_id}: script has no command")
        if action == "skill" and not step_config.get("skill"):
            issues.append(f"Step {step_id}: skill action has no skill name")

    # Check requires
    requires = config.get("requires", {})

    # Check agents exist
    for agent_name in requires.get("agents", []):
        agent_path = settings.workspace_path / "agents" / agent_name / "config.yaml"
        framework_path = settings.framework_path / "agents" / agent_name / "config.yaml"
        if not agent_path.exists() and not framework_path.exists():
            warnings.append(f"Required agent not found: {agent_name}")

    # Check registries exist
    for reg_name in requires.get("registries", []):
        reg_path = settings.workspace_path / "registries" / f"{reg_name}.yaml"
        if not reg_path.exists():
            warnings.append(f"Required registry not found: {reg_name}")

    # Check env vars
    import os
    for var in requires.get("env", []):
        if not os.environ.get(var):
            warnings.append(f"Required env var not set: {var}")

    valid = len(issues) == 0

    return {
        "valid": valid,
        "issues": issues,
        "warnings": warnings,
    }


@router.post("/{flow_id}/trigger")
async def trigger_flow(flow_id: str, body: TriggerPayload = TriggerPayload()):
    """Manually trigger a flow."""
    db = await get_db()
    config = await get_flow_config(db, flow_id)

    if not config:
        raise HTTPException(status_code=404, detail="Flow not found")

    # Add trigger payload to config
    config["trigger_payload"] = body.payload

    # Enqueue the flow job
    job_id = await enqueue(
        action_type="flow",
        action_config=config,
        event_id=f"flow-{flow_id}",
        source="api_trigger",
        priority=5,
    )

    return {
        "message": f"Flow {flow_id} triggered",
        "job_id": job_id,
        "flow_id": flow_id,
    }


@router.get("/{flow_id}/runs")
async def list_flow_runs(flow_id: str, limit: int = 20):
    """List recent runs for a flow."""
    db = await get_db()

    cursor = await db.execute(
        "SELECT id, started_at, completed_at, result, output, duration_ms, error "
        "FROM event_runs WHERE event_id = ? ORDER BY started_at DESC LIMIT ?",
        (f"flow-{flow_id}", limit)
    )
    rows = await cursor.fetchall()

    runs = []
    for row in rows:
        runs.append({
            "id": row[0],
            "started_at": row[1],
            "completed_at": row[2],
            "result": row[3],
            "output": row[4][:500] if row[4] else None,  # Truncate for list
            "duration_ms": row[5],
            "error": row[6],
        })

    return {"runs": runs, "flow_id": flow_id}


@router.get("/{flow_id}/runs/{run_id}")
async def get_flow_run(flow_id: str, run_id: int):
    """Get details of a specific flow run."""
    db = await get_db()

    cursor = await db.execute(
        "SELECT id, started_at, completed_at, result, output, duration_ms, error, worker_id "
        "FROM event_runs WHERE event_id = ? AND id = ?",
        (f"flow-{flow_id}", run_id)
    )
    row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Run not found")

    return {
        "id": row[0],
        "flow_id": flow_id,
        "started_at": row[1],
        "completed_at": row[2],
        "result": row[3],
        "output": row[4],  # Full output
        "duration_ms": row[5],
        "error": row[6],
        "worker_id": row[7],
    }


@router.post("/{flow_id}/enable")
async def enable_flow(flow_id: str):
    """Enable a flow (for scheduled flows)."""
    db = await get_db()

    result = await db.execute(
        "UPDATE events SET status = 'active', updated_at = ? WHERE id = ? AND type = 'flow'",
        (datetime.now(timezone.utc).isoformat(), f"flow-{flow_id}")
    )
    await db.commit()

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Flow not found")

    return {"message": f"Flow {flow_id} enabled", "status": "active"}


@router.post("/{flow_id}/disable")
async def disable_flow(flow_id: str):
    """Disable a flow (pause scheduling)."""
    db = await get_db()

    result = await db.execute(
        "UPDATE events SET status = 'paused', updated_at = ? WHERE id = ? AND type = 'flow'",
        (datetime.now(timezone.utc).isoformat(), f"flow-{flow_id}")
    )
    await db.commit()

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Flow not found")

    return {"message": f"Flow {flow_id} disabled", "status": "paused"}


@router.post("/sync")
async def sync_flows():
    """Re-sync flows from workspace/flows/ to database."""
    db = await get_db()
    counts = await sync_flows_to_events(db)
    return {"message": "Flows synced", "counts": counts}
