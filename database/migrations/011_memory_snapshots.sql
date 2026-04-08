-- Memory snapshots — tracks nexaas_memory stats per workspace over time.
-- Populated hourly by collect-memory-stats Trigger task.
-- Used by instance dashboard to show memory usage trends.

CREATE TABLE IF NOT EXISTS memory_snapshots (
  id                      BIGSERIAL PRIMARY KEY,
  workspace_id            TEXT NOT NULL,
  event_count             INTEGER DEFAULT 0,
  entity_count            INTEGER DEFAULT 0,
  active_fact_count       INTEGER DEFAULT 0,
  relation_count          INTEGER DEFAULT 0,
  active_journal_entries  INTEGER DEFAULT 0,
  embedding_lag           INTEGER DEFAULT 0,
  events_24h              INTEGER DEFAULT 0,
  event_type_breakdown    JSONB DEFAULT '{}',
  oldest_event            TIMESTAMPTZ,
  newest_event            TIMESTAMPTZ,
  snapshot_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_ws
  ON memory_snapshots (workspace_id, snapshot_at DESC);
