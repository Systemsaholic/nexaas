"""Read flow YAML files and sync to events table."""

import json
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
import uuid

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


def _read_flows() -> list[dict[str, Any]]:
    """Read all flow YAML files from workspace/flows/."""
    flows_dir = settings.workspace_path / "flows"
    if not flows_dir.exists():
        return []

    flows = []
    for path in flows_dir.glob("*.yaml"):
        try:
            data = read_yaml(path)
            if isinstance(data, dict) and data.get("id"):
                flows.append(data)
        except Exception as e:
            logger.warning("Failed to read flow %s: %s", path, e)

    return flows


def _trigger_to_condition(trigger: dict[str, Any]) -> tuple[str, str, str]:
    """Convert flow trigger to event condition.

    Returns (condition_type, condition_expr, next_eval_at)
    """
    now = datetime.now(timezone.utc)
    trigger_type = trigger.get("type", "manual")

    if trigger_type == "cron":
        expr = trigger.get("expr", "0 * * * *")
        # Start evaluating in 60 seconds (cron parser will handle actual timing)
        next_eval = (now + timedelta(seconds=60)).isoformat()
        return "cron", expr, next_eval

    if trigger_type == "interval":
        seconds = trigger.get("seconds", 3600)
        next_eval = (now + timedelta(seconds=60)).isoformat()
        return "interval", str(seconds), next_eval

    if trigger_type == "webhook":
        path = trigger.get("path", "")
        # Webhooks don't auto-trigger, set far future
        next_eval = (now + timedelta(days=36500)).isoformat()
        return "webhook", path, next_eval

    if trigger_type == "flow":
        # Triggered after another flow - handled by flow executor
        after_flow = trigger.get("after", "")
        next_eval = (now + timedelta(days=36500)).isoformat()
        return "flow_chain", after_flow, next_eval

    # Manual - only triggered via API
    next_eval = (now + timedelta(days=36500)).isoformat()
    return "manual", "", next_eval


async def sync_flows_to_events(db) -> dict[str, int]:
    """Read flows from workspace/flows/, upsert into events table.

    Returns count of synced flows.
    """
    counts = {"flows": 0, "skipped": 0}
    now = datetime.now(timezone.utc)

    for flow in _read_flows():
        flow_id = flow.get("id")
        if not flow_id:
            counts["skipped"] += 1
            continue

        name = flow.get("name", flow_id)
        description = flow.get("description", "")
        trigger = flow.get("trigger", {"type": "manual"})
        steps = flow.get("steps", [])
        output = flow.get("output", {})
        requires = flow.get("requires", {})

        if not steps:
            logger.warning("Flow %s has no steps, skipping", flow_id)
            counts["skipped"] += 1
            continue

        condition_type, condition_expr, next_eval = _trigger_to_condition(trigger)

        # Store full flow config in action_config
        action_config = json.dumps({
            "flow_id": flow_id,
            "name": name,
            "steps": steps,
            "output": output,
            "requires": requires,
            "trigger": trigger,
        })

        # Metadata for UI
        metadata = json.dumps({
            "flow_name": name,
            "step_count": len(steps),
            "trigger_type": trigger.get("type", "manual"),
        })

        await db.execute(
            "INSERT OR REPLACE INTO events "
            "(id, type, condition_type, condition_expr, next_eval_at, "
            "action_type, action_config, status, description, metadata, "
            "created_at, updated_at) "
            "VALUES (?, 'flow', ?, ?, ?, 'flow', ?, 'active', ?, ?, ?, ?)",
            (f"flow-{flow_id}", condition_type, condition_expr, next_eval,
             action_config, description, metadata,
             now.isoformat(), now.isoformat()),
        )
        counts["flows"] += 1

    if counts["flows"]:
        await db.commit()
        logger.info("Synced %d flows to events", counts["flows"])

    return counts


async def get_flow_config(db, flow_id: str) -> dict[str, Any] | None:
    """Get flow configuration from events table."""
    cursor = await db.execute(
        "SELECT action_config FROM events WHERE id = ? AND type = 'flow'",
        (f"flow-{flow_id}",),
    )
    row = await cursor.fetchone()
    if row:
        return json.loads(row[0])
    return None


async def trigger_chained_flows(db, completed_flow_id: str, success: bool):
    """Find and trigger flows that chain from the completed flow."""
    # Find flows with condition_type='flow_chain' and condition_expr=completed_flow_id
    cursor = await db.execute(
        "SELECT id, action_config FROM events "
        "WHERE type = 'flow' AND condition_type = 'flow_chain' AND condition_expr = ?",
        (completed_flow_id,),
    )
    rows = await cursor.fetchall()

    now = datetime.now(timezone.utc)
    triggered = 0

    for row in rows:
        event_id = row[0]
        config = json.loads(row[1])
        trigger = config.get("trigger", {})

        # Check condition (success/failure/both)
        condition = trigger.get("condition", "success")
        if condition == "success" and not success:
            continue
        if condition == "failure" and success:
            continue
        # "both" or "always" triggers regardless

        # Set next_eval to now to trigger on next tick
        await db.execute(
            "UPDATE events SET next_eval_at = ?, updated_at = ? WHERE id = ?",
            (now.isoformat(), now.isoformat(), event_id),
        )
        triggered += 1

    if triggered:
        await db.commit()
        logger.info("Triggered %d chained flows after %s", triggered, completed_flow_id)

    return triggered
