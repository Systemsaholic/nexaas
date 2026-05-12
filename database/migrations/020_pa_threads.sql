-- PA-as-Router Wave 1 (RFC-0002, #122).
--
-- Foundational schema for domain-scoped per-PA threads:
--
--   1. events.thread_id     — first-class column on the central events table
--                             (justification in RFC §3.1: every PA inbound
--                             classification, every inbox-by-thread query,
--                             every per-thread digest reads WHERE thread_id=$1)
--   2. pa_threads           — declared thread registry, per (workspace, user)
--                             with channel_target opacity (jsonb)
--
-- Forward migration is purely additive — no behavior change until Wave 2
-- wires the new endpoint and Wave 3 wires the resolver shadow drawer.
--
-- Reverse migration drops the column + table and is destructive of any
-- PA-thread state. Production rollback requires operator-level coordination
-- (see #122 acceptance).

ALTER TABLE nexaas_memory.events
  ADD COLUMN IF NOT EXISTS thread_id text;

-- Partial index on the typical PA inbound-classification query:
--   SELECT ... WHERE workspace=$1 AND hall=$2 AND thread_id=$3
--   ORDER BY created_at DESC LIMIT N
-- WHERE-clause skip rows where thread_id is null (the overwhelming majority
-- of rows from non-PA skills) so the index stays compact.
CREATE INDEX IF NOT EXISTS events_user_thread_idx
  ON nexaas_memory.events (workspace, hall, thread_id, created_at DESC)
  WHERE thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS nexaas_memory.pa_threads (
  workspace          text NOT NULL,
  user_hall          text NOT NULL,                -- e.g. "<user_handle>"
  thread_id          text NOT NULL,                -- e.g. "hr"
  display_name       text NOT NULL,                -- "👥 HR"
  status             text NOT NULL DEFAULT 'active',  -- active | paused | closed
  channel_target     jsonb,                        -- e.g. {"telegram":{"chat_id":"-100…","topic_id":3}}
  domain_aliases     text[] DEFAULT '{}',          -- inference hints (RFC §3.4)
  opened_at          timestamptz NOT NULL DEFAULT now(),
  last_activity      timestamptz NOT NULL DEFAULT now(),
  notification_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace, user_hall, thread_id),
  CONSTRAINT pa_threads_status_chk CHECK (status IN ('active', 'paused', 'closed'))
);

CREATE INDEX IF NOT EXISTS pa_threads_user_active_idx
  ON nexaas_memory.pa_threads (workspace, user_hall, status)
  WHERE status = 'active';
