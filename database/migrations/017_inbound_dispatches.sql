-- Inbound-message trigger dispatch log (issue #39).
--
-- The inbound dispatcher watches inbox.messaging.* drawers and fires
-- skills whose manifest declares a matching inbound-message trigger.
-- This table records (drawer × skill) dispatches so re-polls don't
-- re-fire the same skill for the same drawer.
--
-- One row per (drawer, skill) pair — multiple skills can subscribe to
-- the same role, each gets a row.

CREATE TABLE IF NOT EXISTS nexaas_memory.inbound_dispatches (
  workspace        text NOT NULL,
  drawer_id        uuid NOT NULL,
  skill_id         text NOT NULL,
  run_id           uuid,
  status           text NOT NULL,          -- 'dispatched' | 'failed'
  dispatched_at    timestamptz NOT NULL DEFAULT now(),
  error            text,
  PRIMARY KEY (workspace, drawer_id, skill_id)
);

CREATE INDEX IF NOT EXISTS ix_inbound_dispatches_drawer
  ON nexaas_memory.inbound_dispatches (workspace, drawer_id);

CREATE INDEX IF NOT EXISTS ix_inbound_dispatches_recent
  ON nexaas_memory.inbound_dispatches (workspace, dispatched_at DESC);
