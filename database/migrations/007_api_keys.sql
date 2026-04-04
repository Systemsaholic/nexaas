-- Migration 007: AI provider API key management
-- Date: 2026-04-04

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,           -- anthropic, openai, gemini, nexmatic
  key_name TEXT NOT NULL,           -- display name (e.g. "Production Anthropic")
  api_key_masked TEXT NOT NULL,     -- sk-...xxxx (for display only)
  is_default BOOLEAN DEFAULT false, -- use Nexmatic's key when true
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, provider)
);

-- Track which provider/model each workspace should use by default
CREATE TABLE IF NOT EXISTS workspace_ai_config (
  workspace_id TEXT PRIMARY KEY,
  default_provider TEXT DEFAULT 'anthropic',
  default_model TEXT DEFAULT 'claude-sonnet-4-20250514',
  fallback_provider TEXT,
  fallback_model TEXT,
  monthly_token_budget INTEGER,     -- optional cap
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
