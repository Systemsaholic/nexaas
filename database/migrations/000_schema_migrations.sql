-- Migration tracking table.
-- Numbered 000 so it always runs first and bootstraps itself.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
