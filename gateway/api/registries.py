"""Registry API endpoints."""

from fastapi import APIRouter, HTTPException

from config import settings
from readers.yaml_reader import read_yaml

router = APIRouter(prefix="/api", tags=["registries"])


@router.get("/registries")
async def list_registries():
    """List all registry YAML files in {WORKSPACE_ROOT}/registries/."""
    registries_dir = settings.workspace_path / "registries"
    if not registries_dir.is_dir():
        return []

    result = []
    for path in sorted(registries_dir.glob("*.yaml")):
        result.append({
            "name": path.stem,
            "path": str(path),
        })
    return result


@router.get("/registries/{name}")
async def get_registry(name: str):
    """Return parsed contents of a specific registry file."""
    registries_dir = settings.workspace_path / "registries"
    path = registries_dir / f"{name}.yaml"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Registry '{name}' not found")
    data = read_yaml(path)
    return {"name": name, "data": data}
