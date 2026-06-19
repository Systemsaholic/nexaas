-- Migration 027: Waitpoint timeout handled marker (issue #231)
-- Date: 2026-06-19
--
-- The timeout reaper's `escalate` policy (the default) wrote an ops_alert
-- and a WAL entry on every 60s tick but never marked the waitpoint, so an
-- expired-but-unconsumed waitpoint re-alerted forever. Phoenix accumulated
-- ~295 abandoned approval waitpoints from April–May 2026, each firing once
-- per tick = ~35k severity-high ops_alerts every 12 hours, drowning real
-- timeouts and bloating ops_alerts/WAL.
--
-- The auto_{approve,reject,cancel} policies already terminate by clearing
-- dormant_signal — but `escalate` must keep the waitpoint resolvable
-- (resolveWaitpoint looks it up `WHERE dormant_signal = $1`, so a human can
-- still approve it after the escalation). So expiry needs a marker that
-- removes the waitpoint from the *reaper's* view without removing it from
-- the *resolver's* view, and without losing dormant_until for forensics.
--
-- `timeout_handled_at`: NULL = the reaper has not yet applied a timeout
-- policy to this waitpoint. Set once, on the tick that handles expiry.
-- Additive + nullable → backward compatible one release (code N-1 ignores
-- it; rollback unconstrained).

ALTER TABLE nexaas_memory.events
  ADD COLUMN IF NOT EXISTS timeout_handled_at timestamptz;

-- Backfill the existing backlog: every currently-expired active waitpoint
-- is marked handled NOW, silently. They have already alerted thousands of
-- times — they need zero further alerts, just to stop. They stay resolvable
-- (dormant_signal untouched). New expiries (dormant_until passing after this
-- migration) alert exactly once via the fixed reaper.
UPDATE nexaas_memory.events
   SET timeout_handled_at = now()
 WHERE dormant_signal IS NOT NULL
   AND dormant_until IS NOT NULL
   AND dormant_until < now()
   AND timeout_handled_at IS NULL;

-- Precise partial index for the reaper's post-fix query shape — keeps the
-- expired-and-unhandled scan cheap at fleet scale (Phoenix events ≈ 8.9M).
CREATE INDEX IF NOT EXISTS ix_events_dormant_unhandled
  ON nexaas_memory.events (dormant_until)
  WHERE dormant_signal IS NOT NULL AND timeout_handled_at IS NULL;
