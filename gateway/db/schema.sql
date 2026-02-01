CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    condition_expr TEXT NOT NULL,
    next_eval_at TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_config TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    lock_holder TEXT,
    lock_expires_at TEXT,
    last_run_at TEXT,
    last_result TEXT,
    last_output TEXT,
    run_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    consecutive_fails INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    retry_backoff_minutes TEXT DEFAULT '5,15,60',
    priority INTEGER DEFAULT 5,
    concurrency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    workspace TEXT,
    agent TEXT,
    client TEXT,
    description TEXT,
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS event_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT,
    output TEXT,
    duration_ms INTEGER,
    error TEXT,
    worker_id TEXT,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS job_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    source TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    concurrency_key TEXT,
    action_type TEXT NOT NULL,
    action_config TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    worker_id TEXT,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    result TEXT,
    error TEXT,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    workspace TEXT,
    started_at TEXT NOT NULL,
    last_message_at TEXT,
    status TEXT DEFAULT 'active',
    metadata TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);

CREATE TABLE IF NOT EXISTS bus_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    source TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace TEXT,
    agent TEXT,
    session_id TEXT,
    source TEXT NOT NULL,              -- 'chat', 'event_engine', 'worker'
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,                     -- estimated cost at time of call
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_usage_workspace ON token_usage(workspace, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, created_at);

CREATE INDEX IF NOT EXISTS idx_events_next_eval ON events(next_eval_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_queue_status ON job_queue(status, priority) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_runs_event ON event_runs(event_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_bus_events_type ON bus_events(type, created_at);

-- ---------------------------------------------------------------------------
-- Ops monitoring
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ops_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    severity TEXT NOT NULL,          -- info | warning | critical
    category TEXT NOT NULL,          -- worker | engine | db | agent | job
    message TEXT NOT NULL,
    auto_healed INTEGER DEFAULT 0,   -- 1 if self-healed, 0 if escalated
    acknowledged INTEGER DEFAULT 0,
    details TEXT,                     -- JSON blob with diagnostic context
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ops_health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    engine_running INTEGER,
    worker_count INTEGER,
    workers_alive INTEGER,
    pending_jobs INTEGER,
    failed_jobs_last_hour INTEGER,
    stale_locks INTEGER,
    db_ok INTEGER,
    snapshot_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_severity ON ops_alerts(severity, created_at);
CREATE INDEX IF NOT EXISTS idx_ops_health_snapshots_at ON ops_health_snapshots(snapshot_at);
