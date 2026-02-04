"""Read and parse workspace configuration from WORKSPACE_ROOT."""

import json
import logging
from pathlib import Path
from typing import Any

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


def _load_mcp_catalog() -> dict[str, dict[str, Any]]:
    """Load all MCP server definitions from framework/mcp-servers/."""
    catalog: dict[str, dict[str, Any]] = {}
    mcp_dir = settings.framework_path / "mcp-servers"
    if not mcp_dir.is_dir():
        return catalog
    for path in sorted(mcp_dir.glob("*.yaml")):
        defn = read_yaml(path)
        if defn and isinstance(defn, dict) and "name" in defn:
            catalog[defn["name"]] = defn
    return catalog


def list_mcp_catalog() -> list[dict[str, Any]]:
    """Return the full MCP server catalog for the API."""
    return list(_load_mcp_catalog().values())


def _merge_framework_mcp(
    enabled_names: list[str],
    mcp_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge enabled framework MCP servers into the workspace mcp_config.

    Looks up each enabled name in the framework catalog and adds its config
    to mcpServers. Workspace entries with the same name take precedence.
    """
    if mcp_config is None:
        mcp_config = {"mcpServers": {}}

    if not enabled_names:
        return mcp_config

    catalog = _load_mcp_catalog()
    servers = mcp_config.setdefault("mcpServers", {})

    for name in enabled_names:
        if name in servers:
            # Workspace override — skip framework version
            continue
        defn = catalog.get(name)
        if not defn:
            logger.warning("Framework MCP server '%s' not found in catalog", name)
            continue
        config = defn.get("config")
        if config:
            servers[name] = config

    return mcp_config


def read_workspace() -> dict[str, Any]:
    """Read workspace.yaml and supplementary files from WORKSPACE_ROOT.

    Returns a dict with keys: config, claude_md, mcp_config.
    """
    root = settings.workspace_path
    result: dict[str, Any] = {
        "root": str(root),
        "config": None,
        "perspectives": [],
        "pages": [],
        "components": [],
        "registries": [],
        "claude_md": None,
        "mcp_config": None,
    }

    # workspace.yaml
    ws_path = root / "workspace.yaml"
    ws_config = read_yaml(ws_path)
    if ws_config:
        result["config"] = ws_config
        result["perspectives"] = ws_config.get("perspectives", [])
        result["pages"] = ws_config.get("pages", [])
        result["components"] = ws_config.get("components", [])
        result["registries"] = ws_config.get("registries", [])
    else:
        logger.warning("No workspace.yaml found at %s", ws_path)

    # CLAUDE.md
    claude_md_path = root / "CLAUDE.md"
    if claude_md_path.exists():
        result["claude_md"] = claude_md_path.read_text()

    # MCP: enabled framework servers from workspace.yaml
    enabled_names = []
    if ws_config:
        enabled_names = ws_config.get("mcp_servers", [])

    # .mcp.json (custom servers + possible legacy enabledFrameworkServers)
    mcp_config: dict[str, Any] | None = None
    mcp_path = root / ".mcp.json"
    if mcp_path.exists():
        try:
            mcp_config = json.loads(mcp_path.read_text())
            # Support legacy enabledFrameworkServers in .mcp.json too
            legacy = mcp_config.pop("enabledFrameworkServers", [])
            if legacy:
                for name in legacy:
                    if name not in enabled_names:
                        enabled_names.append(name)
        except json.JSONDecodeError:
            logger.error("Invalid JSON in %s", mcp_path)

    result["mcp_config"] = _merge_framework_mcp(enabled_names, mcp_config)

    return result
