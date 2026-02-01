"""Read memory YAML files and sync to events table."""

import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
import uuid

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


def _read_memory_file(filename: str) -> list[dict[str, Any]]:
    """Read a YAML file from the memory directory."""
    path = settings.workspace_path / "memory" / filename
    if not path.exists():
        return []
    data = read_yaml(path)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("items", [])
    return []


async def sync_memory_to_events(db) -> dict[str, int]:
    """Read followups and checks from memory YAML, upsert into events table.

    followups.yaml -> one-time events (condition_type='once')
    checks.yaml -> recurring events (condition_type='interval')

    Returns counts of upserted items.
    """
    counts = {"followups": 0, "checks": 0}
    now = datetime.now(timezone.utc)

    # Followups -> one-time events
    for item in _read_memory_file("followups.yaml"):
        event_id = item.get("id") or f"mem-followup-{uuid.uuid4().hex[:8]}"
        description = item.get("description", "")
        agent = item.get("agent")
        action_config = item.get("action", {})
        if isinstance(action_config, str):
            action_config = {"prompt": action_config}

        due = item.get("due")
        if due:
            next_eval = due
        else:
            next_eval = (now + timedelta(minutes=5)).isoformat()

        await db.execute(
            "INSERT OR REPLACE INTO events "
            "(id, type, condition_type, condition_expr, next_eval_at, "
            "action_type, action_config, status, agent, description, "
            "created_at, updated_at) "
            "VALUES (?, 'memory_followup', 'once', '', ?, 'claude_chat', ?, 'active', ?, ?, ?, ?)",
            (event_id, next_eval,
             str(action_config), agent, description,
             now.isoformat(), now.isoformat()),
        )
        counts["followups"] += 1

    # Checks -> recurring events
    for item in _read_memory_file("checks.yaml"):
        event_id = item.get("id") or f"mem-check-{uuid.uuid4().hex[:8]}"
        description = item.get("description", "")
        agent = item.get("agent")
        interval_seconds = item.get("interval", 3600)
        action_config = item.get("action", {})
        if isinstance(action_config, str):
            action_config = {"prompt": action_config}

        next_eval = (now + timedelta(seconds=60)).isoformat()

        await db.execute(
            "INSERT OR REPLACE INTO events "
            "(id, type, condition_type, condition_expr, next_eval_at, "
            "action_type, action_config, status, agent, description, "
            "created_at, updated_at) "
            "VALUES (?, 'memory_check', 'interval', ?, ?, 'claude_chat', ?, 'active', ?, ?, ?, ?)",
            (event_id, str(interval_seconds), next_eval,
             str(action_config), agent, description,
             now.isoformat(), now.isoformat()),
        )
        counts["checks"] += 1

    if counts["followups"] or counts["checks"]:
        await db.commit()
        logger.info("Synced memory: %d followups, %d checks", counts["followups"], counts["checks"])

    return counts
