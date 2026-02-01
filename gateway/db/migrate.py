"""Simple schema versioning for database migrations."""

import logging
from pathlib import Path

import aiosqlite

logger = logging.getLogger(__name__)

CURRENT_VERSION = 1


async def run_migrations(db: aiosqlite.Connection) -> None:
    """Ensure schema is at the current version."""
    await db.execute(
        "CREATE TABLE IF NOT EXISTS schema_version ("
        "  id INTEGER PRIMARY KEY CHECK (id = 1),"
        "  version INTEGER NOT NULL,"
        "  applied_at TEXT NOT NULL DEFAULT (datetime('now'))"
        ")"
    )
    await db.commit()

    cursor = await db.execute("SELECT version FROM schema_version WHERE id = 1")
    row = await cursor.fetchone()
    current = row[0] if row else 0

    if current < CURRENT_VERSION:
        logger.info("Migrating schema from v%d to v%d", current, CURRENT_VERSION)
        schema_path = Path(__file__).parent / "schema.sql"
        await db.executescript(schema_path.read_text())

        if current == 0:
            await db.execute(
                "INSERT INTO schema_version (id, version) VALUES (1, ?)",
                (CURRENT_VERSION,),
            )
        else:
            await db.execute(
                "UPDATE schema_version SET version = ?, applied_at = datetime('now') WHERE id = 1",
                (CURRENT_VERSION,),
            )
        await db.commit()
        logger.info("Schema migration complete")
    else:
        logger.debug("Schema is up to date at v%d", current)
