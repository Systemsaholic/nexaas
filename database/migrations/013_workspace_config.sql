-- Migration 013: Workspace configuration
-- Date: 2026-04-17
--
-- Per-workspace settings: timezone, default model tier, etc.
-- These are framework-level settings that affect how the runtime
-- operates for a given workspace.

CREATE TABLE IF NOT EXISTS nexaas_memory.workspace_config (
  workspace       text PRIMARY KEY,
  timezone        text NOT NULL DEFAULT 'UTC',
  display_name    text,
  default_model_tier text DEFAULT 'good',
  workspace_root  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
