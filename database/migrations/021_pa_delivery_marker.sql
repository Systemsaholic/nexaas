-- PA-Router outbound delivery marker (RFC-0002, workspace consumer half).
--
-- The /api/pa/<user>/notify endpoint writes pending drawers at
-- `notifications.pending.pa-routed.<thread_id>`. Workspace-side delivery
-- skills (e.g. Phoenix's pa/routed-deliver) consume those drawers and
-- forward to the user's channel target (Telegram today; email/SMS later).
--
-- This table records delivery state per drawer so the delivery skill can
-- enforce at-least-once delivery + retry semantics without mutating the
-- pending drawer itself (event-sourcing principle — drawers are immutable;
-- delivery state lives in a sidecar table). Same pattern as
-- inbound_dispatches (#17) and notification_dispatches (#16).
--
-- Status state machine:
--   queued  → claimed by a delivery worker (insert with status='queued')
--   sent    → channel returned success; channel_message_id captured
--   failed  → transient failure; retries < 3; eligible for re-pickup
--   dead    → exhausted retries; ops alert fired; no further attempts
--   skipped → pa_threads row missing or status != 'active' for this
--             (user, thread); drawer logged + acknowledged + not retried

CREATE TABLE IF NOT EXISTS nexaas_memory.pa_delivery_marker (
  workspace            text NOT NULL,
  drawer_id            uuid NOT NULL,
  user_hall            text NOT NULL,
  thread_id            text NOT NULL,
  channel_message_id   text,                   -- e.g. Telegram message_id; null until 'sent'
  status               text NOT NULL DEFAULT 'queued',
  retries              integer NOT NULL DEFAULT 0,
  last_error           text,
  claimed_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  PRIMARY KEY (workspace, drawer_id),
  CONSTRAINT pa_delivery_marker_status_chk
    CHECK (status IN ('queued', 'sent', 'failed', 'dead', 'skipped'))
);

-- "What did we deliver to this (user, thread) in the last N?" — supports
-- per-thread digest assembly, audit views, observability dashboards.
CREATE INDEX IF NOT EXISTS ix_pa_delivery_marker_thread
  ON nexaas_memory.pa_delivery_marker (workspace, user_hall, thread_id, sent_at DESC)
  WHERE status = 'sent';

-- Delivery-worker scan: "which markers are eligible for (re-)delivery?"
-- Partial index on retryable states keeps it compact even at scale.
CREATE INDEX IF NOT EXISTS ix_pa_delivery_marker_pending
  ON nexaas_memory.pa_delivery_marker (workspace, status, claimed_at)
  WHERE status IN ('queued', 'failed');
