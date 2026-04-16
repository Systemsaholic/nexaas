-- Migration 012: Palace Substrate
-- Date: 2026-04-16
--
-- Transforms the nexaas_memory schema into the full palace substrate:
-- - Extends events table with palace metadata (wing/hall/room, run tracking, waitpoints)
-- - Adds pgvector for semantic retrieval (replacing Qdrant)
-- - Adds WAL with hash chain + operator signing
-- - Adds operator identity + WebAuthn key management
-- - Adds closet compaction + staleness telemetry
-- - Adds skill_runs denormalized index
-- - Adds transactional outbox for Postgres↔Redis atomicity
-- - Adds ops alerts for notification system
-- - Adds client session management
-- - Adds GDPR/PII infrastructure
-- - Adds backup tracking
-- - Adds framework version tracking

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Extensions
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector for semantic retrieval
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid, digest functions

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Palace metadata on events (drawers)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE nexaas_memory.events
  ADD COLUMN IF NOT EXISTS workspace          text,
  ADD COLUMN IF NOT EXISTS wing               text,
  ADD COLUMN IF NOT EXISTS hall               text,
  ADD COLUMN IF NOT EXISTS room               text,
  ADD COLUMN IF NOT EXISTS skill_id           text,
  ADD COLUMN IF NOT EXISTS run_id             uuid,
  ADD COLUMN IF NOT EXISTS step_id            text,
  ADD COLUMN IF NOT EXISTS sub_agent_id       text,
  ADD COLUMN IF NOT EXISTS dormant_signal     text,
  ADD COLUMN IF NOT EXISTS dormant_until      timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_sent      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS normalize_version  int NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS ix_events_palace
  ON nexaas_memory.events (workspace, wing, hall, room);

CREATE INDEX IF NOT EXISTS ix_events_dormant
  ON nexaas_memory.events (dormant_signal)
  WHERE dormant_signal IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_events_run
  ON nexaas_memory.events (run_id, step_id);

CREATE INDEX IF NOT EXISTS ix_events_workspace
  ON nexaas_memory.events (workspace, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Closets — precomputed pointer/landmark index
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.closets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace          text NOT NULL,
  wing               text,
  hall               text,
  room               text,
  topic              text NOT NULL,
  entities           text[],
  drawer_ids         uuid[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  normalize_version  int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ix_closets_palace
  ON nexaas_memory.closets (workspace, wing, hall, room);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Room compaction state — tracks closet freshness
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.room_compaction_state (
  workspace                    text NOT NULL,
  wing                         text NOT NULL,
  hall                         text NOT NULL,
  room                         text NOT NULL,
  last_compacted_at            timestamptz NOT NULL DEFAULT '1970-01-01',
  last_compaction_duration_ms  int,
  last_drawers_compacted       int,
  last_error                   text,
  last_error_at                timestamptz,
  PRIMARY KEY (workspace, wing, hall, room)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Staleness telemetry — per-CAG-read measurement
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.staleness_readings (
  id                   bigserial PRIMARY KEY,
  workspace            text NOT NULL,
  wing                 text NOT NULL,
  hall                 text NOT NULL,
  room                 text NOT NULL,
  cag_run_id           uuid,
  closets_read         int NOT NULL,
  live_tail_drawers    int NOT NULL,
  live_tail_age_ms     bigint NOT NULL,
  compaction_watermark timestamptz,
  read_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_staleness_room_time
  ON nexaas_memory.staleness_readings (workspace, wing, hall, room, read_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Operator identity — unified across ops and client admins
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.operators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    text NOT NULL,
  email           text NOT NULL UNIQUE,
  role            text NOT NULL,          -- ops_admin | ops_member | client_admin
  workspace_scope text[],                 -- NULL = fleet-wide; specific = per-workspace
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  notes           text
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. Operator signing keys — ed25519 (file, WebAuthn, or HSM)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.operator_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  public_key      bytea NOT NULL,
  algorithm       text NOT NULL DEFAULT 'ed25519',
  key_source      text NOT NULL,          -- file | webauthn | hsm
  credential_id   text,                   -- WebAuthn credential ID
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  last_used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS ix_operator_keys_active
  ON nexaas_memory.operator_keys (operator_id) WHERE retired_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. WAL — hash-chained, tamper-evident, with operator signatures
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.wal (
  id                  bigserial PRIMARY KEY,
  workspace           text NOT NULL,
  op                  text NOT NULL,
  actor               text NOT NULL,
  payload             jsonb NOT NULL,
  prev_hash           text NOT NULL,
  hash                text NOT NULL,
  signed_by_key_id    uuid REFERENCES nexaas_memory.operator_keys(id),
  signature           bytea,
  signed_content_hash text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_wal_workspace_hash
  ON nexaas_memory.wal (workspace, hash);

CREATE INDEX IF NOT EXISTS ix_wal_workspace_id
  ON nexaas_memory.wal (workspace, id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. Embeddings — pgvector (replaces Qdrant)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace     text NOT NULL,
  drawer_id     uuid NOT NULL REFERENCES nexaas_memory.events(id),
  wing          text,
  hall          text,
  room          text,
  embedding     vector(1024) NOT NULL,
  model         text NOT NULL DEFAULT 'voyage-3',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_embeddings_workspace_hnsw
  ON nexaas_memory.embeddings
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS ix_embeddings_palace
  ON nexaas_memory.embeddings (workspace, wing, hall, room);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. Skill runs — denormalized index (drawers are authoritative)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.skill_runs (
  run_id            uuid PRIMARY KEY,
  workspace         text NOT NULL,
  skill_id          text NOT NULL,
  skill_version     text,
  agent_id          text,
  trigger_type      text NOT NULL,
  trigger_payload   jsonb,
  status            text NOT NULL DEFAULT 'running',
  current_step      text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_activity     timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  parent_run_id     uuid,
  depth             int NOT NULL DEFAULT 0,
  token_usage       jsonb,
  error_summary     text,
  metadata          jsonb
);

CREATE INDEX IF NOT EXISTS ix_runs_workspace_status
  ON nexaas_memory.skill_runs (workspace, status, last_activity DESC);

CREATE INDEX IF NOT EXISTS ix_runs_workspace_skill
  ON nexaas_memory.skill_runs (workspace, skill_id, started_at DESC);

CREATE INDEX IF NOT EXISTS ix_runs_parent
  ON nexaas_memory.skill_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. Transactional outbox — Postgres↔Redis atomicity
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.outbox (
  id              bigserial PRIMARY KEY,
  workspace       text NOT NULL,
  intent_type     text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  error           text
);

CREATE INDEX IF NOT EXISTS ix_outbox_pending
  ON nexaas_memory.outbox (created_at) WHERE processed_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. Ops alerts — notification system
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.ops_alerts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace             text NOT NULL,
  event_type            text NOT NULL,
  tier                  text NOT NULL,
  severity              text NOT NULL,
  payload               jsonb NOT NULL,
  fired_at              timestamptz NOT NULL DEFAULT now(),
  acknowledged_by       uuid REFERENCES nexaas_memory.operators(id),
  acknowledged_at       timestamptz,
  ack_signature         bytea,
  snoozed_until         timestamptz,
  resolved_at           timestamptz,
  resolution_type       text,
  recurring_count       int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS ix_ops_alerts_active
  ON nexaas_memory.ops_alerts (workspace, event_type, fired_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_ops_alerts_ack_window
  ON nexaas_memory.ops_alerts (workspace, event_type)
  WHERE acknowledged_at IS NOT NULL AND resolved_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. Client sessions — NextAuthJS session tracking
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.client_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id      uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  workspace        text NOT NULL,
  auth_method      text NOT NULL,
  device_label     text,
  ip_address       inet,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity    timestamptz NOT NULL DEFAULT now(),
  absolute_expires timestamptz NOT NULL,
  sliding_expires  timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES nexaas_memory.operators(id),
  revoke_reason    text
);

CREATE INDEX IF NOT EXISTS ix_client_sessions_active
  ON nexaas_memory.client_sessions (operator_id, revoked_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_client_sessions_expiry
  ON nexaas_memory.client_sessions (sliding_expires)
  WHERE revoked_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. Recovery codes — for WebAuthn passkey recovery
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.operator_recovery_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  code_hash     text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  used_at       timestamptz,
  used_ip       inet,
  UNIQUE (operator_id, code_hash)
);

CREATE INDEX IF NOT EXISTS ix_recovery_codes_operator
  ON nexaas_memory.operator_recovery_codes (operator_id, used_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. GDPR — per-subject encryption keys
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.pii_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace       text NOT NULL,
  subject_id      text NOT NULL,
  subject_type    text NOT NULL,
  encryption_key  bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES nexaas_memory.operators(id),
  revoked_reason  text
);

CREATE INDEX IF NOT EXISTS ix_pii_keys_subject
  ON nexaas_memory.pii_keys (workspace, subject_id);

CREATE INDEX IF NOT EXISTS ix_pii_keys_active
  ON nexaas_memory.pii_keys (workspace) WHERE revoked_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. GDPR — redaction records (tombstone pattern)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.pii_redactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace          text NOT NULL,
  original_drawer_id uuid NOT NULL,
  redacted_at        timestamptz NOT NULL DEFAULT now(),
  redacted_by        uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  redaction_signature bytea NOT NULL,
  reason             text NOT NULL,
  request_reference  text,
  preserve_original  boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS ix_pii_redactions_drawer
  ON nexaas_memory.pii_redactions (original_drawer_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 17. GDPR — subject registry (UUID-canonical identity for PII subjects)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.pii_subjects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace       text NOT NULL,
  subject_type    text NOT NULL,
  operator_id     uuid REFERENCES nexaas_memory.operators(id),
  identifiers     jsonb NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_pii_subjects_operator
  ON nexaas_memory.pii_subjects (workspace, operator_id) WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_pii_subjects_identifiers
  ON nexaas_memory.pii_subjects USING gin (identifiers);

-- ═══════════════════════════════════════════════════════════════════════════
-- 18. Backup history — tracking per-workspace backups
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.backup_history (
  id              bigserial PRIMARY KEY,
  workspace       text NOT NULL,
  backup_type     text NOT NULL,
  started_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  size_bytes      bigint,
  bucket          text,
  object_key      text,
  sha256          text,
  status          text NOT NULL,
  error_message   text,
  restore_tested  boolean NOT NULL DEFAULT false,
  restore_test_at timestamptz,
  restore_passed  boolean
);

CREATE INDEX IF NOT EXISTS ix_backup_history_workspace
  ON nexaas_memory.backup_history (workspace, started_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 19. Framework version tracking — per-workspace upgrade history
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS nexaas_memory.framework_versions (
  id                  bigserial PRIMARY KEY,
  workspace           text NOT NULL,
  package_name        text NOT NULL,
  version             text NOT NULL,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  installed_by        uuid REFERENCES nexaas_memory.operators(id),
  install_signature   bytea,
  prior_version       text,
  snapshot_id         text,
  smoke_test_result   jsonb,
  status              text NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_framework_versions_workspace
  ON nexaas_memory.framework_versions (workspace, package_name, installed_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 20. Views — convenience queries over the palace
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW nexaas_memory.active_waitpoints AS
SELECT * FROM nexaas_memory.events
WHERE dormant_signal IS NOT NULL;

CREATE OR REPLACE VIEW nexaas_memory.active_runs AS
SELECT
  run_id,
  workspace,
  skill_id,
  skill_version,
  status,
  current_step,
  started_at,
  last_activity,
  parent_run_id,
  depth,
  token_usage
FROM nexaas_memory.skill_runs
WHERE status IN ('running', 'waiting', 'escalated');

-- ═══════════════════════════════════════════════════════════════════════════
-- 21. Record this migration
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO schema_migrations (version, name, applied_at)
VALUES ('012', 'palace_substrate', now())
ON CONFLICT DO NOTHING;
