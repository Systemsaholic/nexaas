"""Simple schema versioning for database migrations."""

import logging
from pathlib import Path

import aiosqlite

logger = logging.getLogger(__name__)

CURRENT_VERSION = 3


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

        # Re-run base schema (idempotent CREATE IF NOT EXISTS)
        schema_path = Path(__file__).parent / "schema.sql"
        await db.executescript(schema_path.read_text())

        # Apply incremental migrations
        migrations_dir = Path(__file__).parent / "migrations"
        for version in range(current + 1, CURRENT_VERSION + 1):
            migration_file = migrations_dir / f"{version:03d}_*.sql"
            # Find the matching file
            matches = list(migrations_dir.glob(f"{version:03d}_*.sql"))
            for mf in matches:
                logger.info("Applying migration: %s", mf.name)
                try:
                    await db.executescript(mf.read_text())
                except Exception as exc:
                    # Column already exists is OK for idempotent migrations
                    if "duplicate column" in str(exc).lower():
                        logger.debug("Migration %s: column already exists, skipping", mf.name)
                    else:
                        raise

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
