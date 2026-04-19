-- Fleet versioning + heartbeat state.
-- Local to each client VPS. The central ops dashboard (Nexmatic) receives
-- pushed heartbeats from these installs via NEXAAS_FLEET_ENDPOINT and
-- maintains its own aggregate fleet table in its own DB.

-- Single-row state table — UPDATEd, not appended. History lives in the WAL
-- (op: `framework_heartbeat_sent` / `framework_heartbeat_failed`).
CREATE TABLE IF NOT EXISTS nexaas_memory.framework_heartbeat (
  workspace          text PRIMARY KEY,
  version            text NOT NULL,
  commit_sha         text,
  branch             text,
  hostname           text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  last_push_at       timestamptz,
  last_push_status   text,           -- 'ok' | 'failed:<reason>'
  last_push_http     int,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Stamp the framework version that produced each run. Valuable for
-- forensics: when a skill behaves differently after an upgrade we can
-- point at the exact framework commit that produced each run.
ALTER TABLE nexaas_memory.skill_runs
  ADD COLUMN IF NOT EXISTS framework_version text;

CREATE INDEX IF NOT EXISTS ix_skill_runs_framework_version
  ON nexaas_memory.skill_runs (workspace, framework_version)
  WHERE framework_version IS NOT NULL;
