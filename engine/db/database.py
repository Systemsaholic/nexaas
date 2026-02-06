"""Async SQLite connection management with singleton pattern."""

import logging
from pathlib import Path

import aiosqlite

from config import settings

logger = logging.getLogger(__name__)

_connection: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """Return the singleton database connection, creating it if needed."""
    global _connection
    if _connection is None:
        db_path = settings.database_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        _connection = await aiosqlite.connect(str(db_path))
        _connection.row_factory = aiosqlite.Row
        await _connection.execute("PRAGMA journal_mode=WAL")
        await _connection.execute("PRAGMA foreign_keys=ON")
        logger.info("Database connection established: %s", db_path)
    return _connection


async def init_db() -> None:
    """Initialize database by running schema.sql."""
    db = await get_db()
    schema_path = Path(__file__).parent / "schema.sql"
    schema_sql = schema_path.read_text()
    await db.executescript(schema_sql)
    await db.commit()
    logger.info("Database schema initialized")

    # Run migrations
    from db.migrate import run_migrations
    await run_migrations(db)

    # Sync memory items (followups, checks) to events
    from readers.memory_reader import sync_memory_to_events
    await sync_memory_to_events(db)

    # Sync flows to events
    from readers.flow_reader import sync_flows_to_events
    await sync_flows_to_events(db)


async def close_db() -> None:
    """Close the database connection."""
    global _connection
    if _connection is not None:
        await _connection.close()
        _connection = None
        logger.info("Database connection closed")
