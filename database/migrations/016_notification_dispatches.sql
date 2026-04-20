-- Notification dispatch idempotency table (issue #40).
--
-- The outbound subscriber writes a row before calling the channel MCP.
-- Claim uses INSERT ... ON CONFLICT (workspace, idempotency_key) DO NOTHING
-- so concurrent subscribers or retries never double-post. The row records
-- the native channel id on success so adapters can later edit/delete.

CREATE TABLE IF NOT EXISTS nexaas_memory.notification_dispatches (
  workspace            text NOT NULL,
  idempotency_key      text NOT NULL,
  channel_role         text NOT NULL,
  channel_kind         text,
  channel_mcp          text,
  drawer_id            uuid,           -- the pending drawer that triggered the dispatch
  status               text NOT NULL,  -- 'claimed' | 'delivered' | 'failed' | 'released'
  attempts             int NOT NULL DEFAULT 0,
  channel_message_id   text,           -- native id from adapter on success
  last_error           text,
  claimed_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  PRIMARY KEY (workspace, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_notif_dispatches_status
  ON nexaas_memory.notification_dispatches (workspace, status, claimed_at);

CREATE INDEX IF NOT EXISTS ix_notif_dispatches_drawer
  ON nexaas_memory.notification_dispatches (drawer_id)
  WHERE drawer_id IS NOT NULL;
