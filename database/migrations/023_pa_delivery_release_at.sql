-- Add release_at gate to pa_delivery_marker so the framework can hold
-- a notification until its tier-specific release time without coupling
-- delivery scheduling to any particular consumer architecture.
--
-- claimNextDelivery filters by `release_at <= now()`, so held rows are
-- invisible to workspace consumers; once the timestamp passes, the row
-- becomes claimable on the next tick.
--
-- Tier → release_at mapping is computed at enqueue time by the
-- framework helper, with workspace-overridable defaults via env vars:
--   immediate → now()
--   normal    → now() + NEXAAS_PA_NORMAL_HOLD_MINUTES (default 15)
--   low       → next NEXAAS_PA_LOW_RELEASE_HOUR:MINUTE (default 07:30)
--
-- DEFAULT now() means existing rows from before this migration are
-- treated as "release-immediately" — backwards-compatible for any
-- consumer already draining the table.

ALTER TABLE nexaas_memory.pa_delivery_marker
  ADD COLUMN IF NOT EXISTS release_at timestamptz NOT NULL DEFAULT now();

-- Pending-scan index must include release_at so the dispatcher's
-- claim query stays index-only on the common case of "what's eligible
-- right now". The existing partial index on (workspace, status,
-- claimed_at) WHERE status IN ('queued','failed') doesn't help once
-- the WHERE clause adds release_at <= now() — Postgres still has to
-- check each candidate row's release_at.
DROP INDEX IF EXISTS nexaas_memory.ix_pa_delivery_marker_pending;
CREATE INDEX IF NOT EXISTS ix_pa_delivery_marker_pending
  ON nexaas_memory.pa_delivery_marker (workspace, status, release_at, claimed_at)
  WHERE status IN ('queued', 'failed');
