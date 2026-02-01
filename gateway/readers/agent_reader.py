"""Discover and parse agent configurations from WORKSPACE_ROOT/agents/."""

import logging
from pathlib import Path
from typing import Any

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


def discover_agents() -> list[dict[str, Any]]:
    """Discover all agents in {WORKSPACE_ROOT}/agents/*/config.yaml.

    Returns a flat list of agent dicts, each containing config and optional prompt.
    """
    agents_dir = settings.workspace_path / "agents"
    if not agents_dir.is_dir():
        logger.debug("No agents directory at %s", agents_dir)
        return []

    agents: list[dict[str, Any]] = []
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

        agents.append({
            "name": name,
            "dir": str(agent_dir),
            "config": config,
            "prompt": prompt,
            "parent": config.get("parent"),
        })

    return agents


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
