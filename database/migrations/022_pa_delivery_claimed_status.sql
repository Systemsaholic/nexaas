-- Extend pa_delivery_marker status enum with 'claimed' (intermediate state
-- between 'queued'/'failed' and terminal 'sent'/'failed'/'dead'). Lets a
-- delivery consumer atomically lease a row, do its outbound work outside
-- the claim transaction (so a slow telegram/email send doesn't hold a
-- Postgres connection), and report back via markDeliverySent /
-- markDeliveryFailed. A reaper resets stale claimed rows back to 'failed'
-- so a crashed consumer doesn't strand a delivery.

ALTER TABLE nexaas_memory.pa_delivery_marker
  DROP CONSTRAINT IF EXISTS pa_delivery_marker_status_chk;

ALTER TABLE nexaas_memory.pa_delivery_marker
  ADD CONSTRAINT pa_delivery_marker_status_chk
  CHECK (status IN ('queued', 'claimed', 'sent', 'failed', 'dead', 'skipped'));

-- Reaper index: find stale 'claimed' rows whose lease has expired.
-- Compact partial index — most rows are not in 'claimed' state at any
-- given moment.
CREATE INDEX IF NOT EXISTS ix_pa_delivery_marker_claimed
  ON nexaas_memory.pa_delivery_marker (workspace, claimed_at)
  WHERE status = 'claimed';
