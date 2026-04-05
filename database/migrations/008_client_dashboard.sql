-- Migration 008: Client dashboard — auth, integrations, approvals, activity
-- Date: 2026-04-05

-- Extend users table for client auth + TOTP
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS invite_token TEXT,
  ADD COLUMN IF NOT EXISTS invite_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

-- Create unique index on email (partial — only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Client integration connections (OAuth tokens, API keys)
CREATE TABLE IF NOT EXISTS integration_connections (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires TIMESTAMPTZ,
  scopes TEXT[],
  metadata JSONB DEFAULT '{}',
  connected_at TIMESTAMPTZ,
  error_message TEXT,
  UNIQUE(workspace_id, provider)
);

-- Pending approvals (TAG approval_required actions)
CREATE TABLE IF NOT EXISTS pending_approvals (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

-- Activity log (what the AI did)
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  skill_id TEXT,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  tag_route TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_workspace ON pending_approvals(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_connections_workspace ON integration_connections(workspace_id);
