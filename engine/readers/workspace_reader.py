"""Read and parse workspace configuration from WORKSPACE_ROOT."""

import json
import logging
from pathlib import Path
from typing import Any

from config import settings
from readers.yaml_reader import read_yaml

logger = logging.getLogger(__name__)


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

    # .mcp.json
    mcp_path = root / ".mcp.json"
    if mcp_path.exists():
        try:
            result["mcp_config"] = json.loads(mcp_path.read_text())
        except json.JSONDecodeError:
            logger.error("Invalid JSON in %s", mcp_path)

    return result
