"""Generic cached YAML reader with mtime-based invalidation."""

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_cache: dict[str, tuple[float, Any]] = {}


def read_yaml(path: str | Path) -> Any:
    """Read and parse a YAML file with in-memory caching.

    Cache is invalidated when the file's mtime changes.
    Returns None if the file does not exist.
    """
    p = Path(path).resolve()
    if not p.exists():
        logger.debug("YAML file not found: %s", p)
        return None

    mtime = p.stat().st_mtime
    key = str(p)

    if key in _cache:
        cached_mtime, cached_data = _cache[key]
        if cached_mtime == mtime:
            return cached_data

    logger.debug("Loading YAML: %s", p)
    with open(p) as f:
        data = yaml.safe_load(f)

    _cache[key] = (mtime, data)
    return data


def invalidate_cache(path: str | Path | None = None) -> None:
    """Clear cache for a specific path or all paths."""
    if path is None:
        _cache.clear()
    else:
        _cache.pop(str(Path(path).resolve()), None)
