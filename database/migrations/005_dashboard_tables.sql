-- Migration 005: Dashboard tables — accounts, deploy_runs, health extensions
-- Date: 2026-04-04

-- Extend ops_health_snapshots with per-workspace VPS metrics
ALTER TABLE ops_health_snapshots
  ADD COLUMN IF NOT EXISTS workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS ram_used_mb INTEGER,
  ADD COLUMN IF NOT EXISTS ram_total_mb INTEGER,
  ADD COLUMN IF NOT EXISTS disk_used_gb REAL,
  ADD COLUMN IF NOT EXISTS disk_total_gb REAL,
  ADD COLUMN IF NOT EXISTS container_count INTEGER,
  ADD COLUMN IF NOT EXISTS containers_healthy INTEGER,
  ADD COLUMN IF NOT EXISTS worker_active BOOLEAN,
  ADD COLUMN IF NOT EXISTS vps_ip TEXT;

CREATE INDEX IF NOT EXISTS idx_health_workspace
  ON ops_health_snapshots(workspace_id, snapshot_at DESC);

-- Accounts table (v2-ready for Stripe integration)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  plan TEXT DEFAULT 'trial',
  status TEXT DEFAULT 'active',
  monthly_minimum_cents INTEGER DEFAULT 0,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deploy runs tracking
CREATE TABLE IF NOT EXISTS deploy_runs (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  vps_ip TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  trigger_run_id TEXT,
  status TEXT DEFAULT 'pending',
  current_step INTEGER DEFAULT 0,
  steps JSONB DEFAULT '[]',
  log_output TEXT DEFAULT '',
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Extend workspaces with account linkage and limits
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS monthly_token_limit INTEGER,
  ADD COLUMN IF NOT EXISTS concurrency_limit INTEGER DEFAULT 2;
