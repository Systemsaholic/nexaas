"""Skills API endpoints."""

import logging

from fastapi import APIRouter

from orchestrator.session_manager import manager
from readers.skill_reader import discover_skills, get_skill

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/skills", tags=["skills"])


@router.get("")
async def list_skills():
    """List all discovered skills (merged framework + client)."""
    return discover_skills()


@router.get("/{name}")
async def get_skill_detail(name: str):
    """Get a single skill by name."""
    skill = get_skill(name)
    if not skill:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"detail": f"Skill not found: {name}"})
    return skill


@router.post("/{name}/execute")
async def execute_skill(name: str):
    """Execute a skill via Claude Code session."""
    skill = get_skill(name)
    if not skill:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"detail": f"Skill not found: {name}"})

    # Read the skill markdown content
    from pathlib import Path
    skill_path = Path(skill["path"])
    skill_content = skill_path.read_text() if skill_path.exists() else ""

    session_id = manager.create_session(agent="default")
    try:
        output_parts = []
        prompt = f"Execute the following skill:\n\n{skill_content}"

        import json
        async for line in manager.send_message(session_id, prompt):
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if chunk.get("type") == "result":
                result_text = chunk.get("result", "")
                if result_text:
                    output_parts.append(result_text)
            elif chunk.get("type") == "assistant" and "message" in chunk:
                msg = chunk["message"]
                if isinstance(msg, dict):
                    for block in msg.get("content", []):
                        if isinstance(block, dict) and block.get("type") == "text":
                            output_parts.append(block.get("text", ""))

        return {
            "skill": name,
            "result": "".join(output_parts) or "Skill executed (no output)",
        }
    finally:
        await manager.destroy_session(session_id)
