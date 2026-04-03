-- Nexaas v2 Unified Schema (Postgres)
-- Combines existing engine tables (converted from SQLite) with new v2 tables.

-- ============================================================================
-- Existing tables (migrated from engine/db/schema.sql)
-- ============================================================================

CREATE TABLE IF NOT EXISTS events (
    id                      TEXT PRIMARY KEY,
    type                    TEXT NOT NULL,
    condition_type          TEXT NOT NULL,
    condition_expr          TEXT NOT NULL,
    next_eval_at            TIMESTAMPTZ NOT NULL,
    action_type             TEXT NOT NULL,
    action_config           JSONB NOT NULL,
    status                  TEXT DEFAULT 'active',
    lock_holder             TEXT,
    lock_expires_at         TIMESTAMPTZ,
    last_run_at             TIMESTAMPTZ,
    last_result             TEXT,
    last_output             TEXT,
    run_count               INTEGER DEFAULT 0,
    fail_count              INTEGER DEFAULT 0,
    consecutive_fails       INTEGER DEFAULT 0,
    max_retries             INTEGER DEFAULT 3,
    retry_backoff_minutes   TEXT DEFAULT '5,15,60',
    priority                INTEGER DEFAULT 5,
    concurrency_key         TEXT,
    created_at              TIMESTAMPTZ NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL,
    expires_at              TIMESTAMPTZ,
    workspace               TEXT,
    agent                   TEXT,
    client                  TEXT,
    description             TEXT,
    metadata                JSONB
);

CREATE TABLE IF NOT EXISTS event_runs (
    id              BIGSERIAL PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES events(id),
    started_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,
    result          TEXT,
    output          TEXT,
    duration_ms     INTEGER,
    error           TEXT,
    worker_id       TEXT
);

CREATE TABLE IF NOT EXISTS job_queue (
    id              BIGSERIAL PRIMARY KEY,
    event_id        TEXT REFERENCES events(id),
    source          TEXT NOT NULL,
    priority        INTEGER DEFAULT 5,
    concurrency_key TEXT,
    action_type     TEXT NOT NULL,
    action_config   JSONB NOT NULL,
    status          TEXT DEFAULT 'queued',
    worker_id       TEXT,
    queued_at       TIMESTAMPTZ NOT NULL,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    result          TEXT,
    error           TEXT
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id                TEXT PRIMARY KEY,
    agent             TEXT NOT NULL,
    workspace         TEXT,
    started_at        TIMESTAMPTZ NOT NULL,
    last_message_at   TIMESTAMPTZ,
    status            TEXT DEFAULT 'active',
    metadata          JSONB,
    claude_session_id TEXT,
    session_type      TEXT DEFAULT 'claude_code'
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES chat_sessions(id),
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    tool_calls  JSONB,
    created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bus_events (
    id          BIGSERIAL PRIMARY KEY,
    type        TEXT NOT NULL,
    source      TEXT,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
    id                      BIGSERIAL PRIMARY KEY,
    workspace               TEXT,
    agent                   TEXT,
    session_id              TEXT,
    source                  TEXT NOT NULL,
    model                   TEXT NOT NULL,
    input_tokens            INTEGER NOT NULL DEFAULT 0,
    output_tokens           INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd                REAL,
    created_at              TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_alerts (
    id              BIGSERIAL PRIMARY KEY,
    severity        TEXT NOT NULL,
    category        TEXT NOT NULL,
    message         TEXT NOT NULL,
    auto_healed     BOOLEAN DEFAULT FALSE,
    acknowledged    BOOLEAN DEFAULT FALSE,
    details         JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ops_health_snapshots (
    id                      BIGSERIAL PRIMARY KEY,
    engine_running          BOOLEAN,
    worker_count            INTEGER,
    workers_alive           INTEGER,
    pending_jobs            INTEGER,
    failed_jobs_last_hour   INTEGER,
    stale_locks             INTEGER,
    db_ok                   BOOLEAN,
    snapshot_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS companies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL REFERENCES companies(id),
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- New v2 tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    workspace_root  TEXT NOT NULL,
    manifest        JSONB NOT NULL,
    worker_status   TEXT DEFAULT 'unknown',
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_contexts (
    thread_id       TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    skill_id        TEXT,
    turns           JSONB NOT NULL DEFAULT '[]',
    summary         TEXT,
    artifacts       JSONB NOT NULL DEFAULT '[]',
    status          TEXT DEFAULT 'active',
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_feedback (
    id                      BIGSERIAL PRIMARY KEY,
    skill_id                TEXT NOT NULL,
    workspace_id            TEXT NOT NULL,
    session_id              TEXT,
    signal                  TEXT NOT NULL,
    evidence                JSONB,
    claude_reflection       TEXT,
    proposed_improvement    TEXT,
    collected               BOOLEAN DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_proposals (
    id                      BIGSERIAL PRIMARY KEY,
    skill_id                TEXT NOT NULL,
    workspace_id            TEXT NOT NULL,
    from_version            TEXT NOT NULL,
    proposed_version        TEXT NOT NULL,
    proposed_improvement    TEXT NOT NULL,
    status                  TEXT DEFAULT 'pending',
    violations              JSONB,
    pass1_clean             BOOLEAN,
    pass2_clean             BOOLEAN,
    reviewer_summary        TEXT,
    clean_version           TEXT,
    disposition             TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    trigger_run_id          TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skill_versions (
    id              BIGSERIAL PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    version         TEXT NOT NULL,
    status          TEXT DEFAULT 'stable',
    manifest        JSONB NOT NULL,
    promoted_from   TEXT,
    promoted_at     TIMESTAMPTZ,
    UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS workspace_skills (
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    skill_id        TEXT NOT NULL,
    pinned_version  TEXT,
    active          BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (workspace_id, skill_id)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Existing
CREATE INDEX IF NOT EXISTS idx_events_next_eval ON events(next_eval_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_queue_status ON job_queue(status, priority) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_runs_event ON event_runs(event_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_bus_events_type ON bus_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_workspace ON token_usage(workspace, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, created_at);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_severity ON ops_alerts(severity, created_at);
CREATE INDEX IF NOT EXISTS idx_ops_health_snapshots_at ON ops_health_snapshots(snapshot_at);

-- New v2
CREATE INDEX IF NOT EXISTS idx_conversation_workspace ON conversation_contexts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversation_status ON conversation_contexts(status);
CREATE INDEX IF NOT EXISTS idx_skill_feedback_skill ON skill_feedback(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_feedback_signal ON skill_feedback(signal);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_status ON skill_proposals(status);
CREATE INDEX IF NOT EXISTS idx_skill_proposals_skill ON skill_proposals(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_feedback_collected ON skill_feedback(collected) WHERE collected = false;
