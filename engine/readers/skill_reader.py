"""Discover and parse skill definitions from markdown files."""

import logging
import re
from pathlib import Path
from typing import Any

from config import settings

logger = logging.getLogger(__name__)


def _parse_skill_md(path: Path) -> dict[str, Any]:
    """Parse a skill markdown file for name and description from the header."""
    text = path.read_text()

    name = path.stem
    description = ""

    # Look for # heading as name
    heading_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    if heading_match:
        name = heading_match.group(1).strip()

    # First non-heading, non-empty line as description
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            description = stripped
            break

    return {
        "name": name,
        "filename": path.name,
        "description": description,
        "path": str(path),
    }


def _scan_skills_dir(skills_dir: Path) -> dict[str, dict[str, Any]]:
    """Scan a directory for .md skill files. Returns dict keyed by filename."""
    if not skills_dir.is_dir():
        return {}

    skills: dict[str, dict[str, Any]] = {}
    for path in sorted(skills_dir.glob("*.md")):
        skill = _parse_skill_md(path)
        skills[path.name] = skill

    return skills


def discover_skills() -> list[dict[str, Any]]:
    """Discover all skills, merging framework and client dirs.

    Same filename in both: client wins.
    """
    framework_skills = _scan_skills_dir(settings.framework_path / "skills")
    client_skills = _scan_skills_dir(settings.workspace_path / "skills")

    merged = {**framework_skills, **client_skills}

    for filename, skill in merged.items():
        if filename in client_skills:
            skill["source"] = "client"
        else:
            skill["source"] = "framework"

    return list(merged.values())


def get_skill(name: str) -> dict[str, Any] | None:
    """Get a skill by name (matching filename stem or parsed name)."""
    for skill in discover_skills():
        if skill["filename"].removesuffix(".md") == name or skill["name"] == name:
            return skill
    return None
