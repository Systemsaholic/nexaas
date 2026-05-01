-- Batch trigger primitive (#80).
--
-- Each row tracks one fired batch — the accumulated items at the moment the
-- consumer skill was kicked, plus the reason the fire-when condition matched.
-- Items themselves stay in `nexaas_memory.events` at `wing='batch'`,
-- `hall='<bucket>'`, `room='pending.*'` (or `archived.*` after the consumer
-- succeeds). The batch_id ties them together for re-delivery on consumer
-- failure.
--
-- Same idempotency pattern as notification_dispatches: claim before fire,
-- so a multi-worker race can't double-dispatch the same batch.

CREATE TABLE IF NOT EXISTS nexaas_memory.batch_dispatches (
  workspace        text NOT NULL,
  bucket           text NOT NULL,
  batch_id         uuid NOT NULL,
  skill_id         text NOT NULL,
  status           text NOT NULL,         -- 'claimed' | 'dispatched' | 'completed' | 'failed'
  item_drawer_ids  uuid[] NOT NULL,
  fire_reason      text NOT NULL,         -- 'count_at_least:10' | 'cron' | 'oldest_age_at_least:1h' | 'at'
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  completed_at     timestamptz,
  last_error       text,
  PRIMARY KEY (workspace, batch_id)
);

CREATE INDEX IF NOT EXISTS ix_batch_dispatches_bucket_status
  ON nexaas_memory.batch_dispatches (workspace, bucket, status, claimed_at DESC);

CREATE INDEX IF NOT EXISTS ix_batch_dispatches_pending_items
  ON nexaas_memory.batch_dispatches USING gin (item_drawer_ids)
  WHERE status IN ('claimed', 'dispatched');
