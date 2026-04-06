-- Migration 009: Architecture Guide v4 — new pillars
-- Date: 2026-04-06
-- Tables: agent_memory, feedback_events, channel_registry, user_channel_preferences, heartbeat_schedules

-- Agent persistent memory (per department, per client)
CREATE TABLE IF NOT EXISTS agent_memory (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  department TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, department, memory_type, key)
);

-- Feedback events (all feedback, all sources, with delta capture)
CREATE TABLE IF NOT EXISTS feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id TEXT,
  workspace_id TEXT NOT NULL,
  skill_id TEXT,
  gate_id TEXT,
  source TEXT NOT NULL,
  original_output TEXT,
  feedback_type TEXT NOT NULL,
  feedback_value TEXT,
  edited_output TEXT,
  delta JSONB,
  downstream_action TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channel Registry (per instance)
CREATE TABLE IF NOT EXISTS channel_registry (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  criticality TEXT DEFAULT 'standard',
  latency TEXT DEFAULT 'async',
  implementation JSONB NOT NULL,
  capabilities TEXT[],
  format_constraints JSONB DEFAULT '{}',
  fallback_channel TEXT,
  health_check BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, channel_id)
);

-- User channel preferences
CREATE TABLE IF NOT EXISTS user_channel_preferences (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_role TEXT,
  preference_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_email, preference_type)
);

-- HEARTBEAT schedule registry
CREATE TABLE IF NOT EXISTS heartbeat_schedules (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  department TEXT NOT NULL,
  schedule_key TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  trigger_task_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  silence_condition TEXT,
  active BOOLEAN DEFAULT true,
  last_run TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, department, schedule_key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_memory_dept ON agent_memory(workspace_id, department);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(workspace_id, department, memory_type);
CREATE INDEX IF NOT EXISTS idx_feedback_events_run ON feedback_events(task_run_id);
CREATE INDEX IF NOT EXISTS idx_feedback_events_skill ON feedback_events(workspace_id, skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_events_source ON feedback_events(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_registry_ws ON channel_registry(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_prefs_ws ON user_channel_preferences(workspace_id, user_email);
CREATE INDEX IF NOT EXISTS idx_heartbeat_ws ON heartbeat_schedules(workspace_id, active);
