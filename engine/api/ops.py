"""Ops monitoring API router."""

import json

from fastapi import APIRouter, HTTPException, Query

from db.database import get_db
from orchestrator.ops_monitor import HEAL_ACTIONS

router = APIRouter(prefix="/api", tags=["ops"])


@router.get("/ops/health")
async def ops_health():
    """Return the latest health snapshot."""
    db = await get_db()
    cursor = await db.execute(
        "SELECT engine_running, worker_count, workers_alive, pending_jobs, "
        "failed_jobs_last_hour, stale_locks, db_ok, snapshot_at "
        "FROM ops_health_snapshots ORDER BY id DESC LIMIT 1"
    )
    row = await cursor.fetchone()
    if not row:
        return {
            "engine_running": True, "worker_count": 0, "workers_alive": 0,
            "pending_jobs": 0, "failed_jobs_last_hour": 0, "stale_locks": 0,
            "db_ok": True, "snapshot_at": None,
        }
    return {
        "engine_running": bool(row[0]),
        "worker_count": row[1],
        "workers_alive": row[2],
        "pending_jobs": row[3],
        "failed_jobs_last_hour": row[4],
        "stale_locks": row[5],
        "db_ok": bool(row[6]),
        "snapshot_at": row[7],
    }


@router.get("/ops/alerts")
async def ops_alerts(
    limit: int = Query(50, le=200),
    severity: str | None = Query(None),
):
    """Return recent ops alerts."""
    db = await get_db()
    clauses = []
    params: list = []
    if severity:
        clauses.append("severity = ?")
        params.append(severity)
    where = " AND ".join(clauses) if clauses else "1=1"
    cursor = await db.execute(
        f"SELECT id, severity, category, message, auto_healed, acknowledged, details, created_at "
        f"FROM ops_alerts WHERE {where} ORDER BY id DESC LIMIT ?",
        params + [limit],
    )
    rows = await cursor.fetchall()
    return [
        {
            "id": r[0], "severity": r[1], "category": r[2], "message": r[3],
            "auto_healed": bool(r[4]), "acknowledged": bool(r[5]),
            "details": json.loads(r[6]) if r[6] else None, "created_at": r[7],
        }
        for r in rows
    ]


@router.post("/ops/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: int):
    """Mark an alert as acknowledged."""
    db = await get_db()
    result = await db.execute(
        "UPDATE ops_alerts SET acknowledged = 1 WHERE id = ?", (alert_id,)
    )
    await db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"ok": True}


@router.post("/ops/heal/{action}")
async def trigger_heal(action: str):
    """Manually trigger a specific heal action."""
    handler = HEAL_ACTIONS.get(action)
    if not handler:
        raise HTTPException(status_code=400, detail=f"Unknown heal action: {action}")
    result = await handler()
    return {"action": action, "result": result}
