"""Discover and parse agent configurations with framework/client merge."""

import logging
from pathlib import Path
from typing import Any

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


def _scan_agents_dir(agents_dir: Path) -> dict[str, dict[str, Any]]:
    """Scan a directory for agent configs. Returns dict keyed by agent name."""
    if not agents_dir.is_dir():
        return {}

    agents: dict[str, dict[str, Any]] = {}
    for agent_dir in sorted(agents_dir.iterdir()):
        config_path = agent_dir / "config.yaml"
        if not config_path.exists():
            continue

        config = read_yaml(config_path) or {}
        name = config.get("name", agent_dir.name)

        prompt = None
        prompt_path = agent_dir / "prompt.md"
        if prompt_path.exists():
            prompt = prompt_path.read_text()

        agents[name] = {
            "name": name,
            "dir": str(agent_dir),
            "config": config,
            "prompt": prompt,
            "parent": config.get("parent"),
        }

    return agents


def discover_agents() -> list[dict[str, Any]]:
    """Discover all agents, merging framework and client dirs.

    Scans framework/agents/ first, then workspace/agents/.
    Same agent name in both: client wins (full replacement).
    """
    # Framework agents
    framework_agents = _scan_agents_dir(settings.framework_path / "agents")

    # Client/workspace agents
    client_agents = _scan_agents_dir(settings.workspace_path / "agents")

    # Merge: client wins
    merged = {**framework_agents, **client_agents}

    # Tag source
    for name, agent in merged.items():
        if name in client_agents:
            agent["source"] = "client"
        else:
            agent["source"] = "framework"

    return list(merged.values())


def build_agent_tree() -> list[dict[str, Any]]:
    """Build a hierarchical agent tree based on the parent field."""
    agents = discover_agents()
    by_name: dict[str, dict[str, Any]] = {}
    for agent in agents:
        agent["children"] = []
        by_name[agent["name"]] = agent

    roots: list[dict[str, Any]] = []
    for agent in agents:
        parent_name = agent.get("parent")
        if parent_name and parent_name in by_name:
            by_name[parent_name]["children"].append(agent)
        else:
            roots.append(agent)

    return roots


def get_agent(name: str) -> dict[str, Any] | None:
    """Get a single agent by name."""
    agents = discover_agents()
    for agent in agents:
        if agent["name"] == name:
            return agent
    return None
