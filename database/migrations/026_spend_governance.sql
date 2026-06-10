-- Migration 026: Spend governance — per-workspace daily AI budget (issue #215)
-- Date: 2026-06-10
--
-- Nexmatic provisions the model keys for most client workspaces, so a
-- runaway agentic loop burns the operator's margin directly. Per-run
-- guardrails (#25) bound a single run; nothing bounds a workspace's *day*.
--
-- Two pieces:
--   1. workspace_config.spend_daily_budget_usd — the budget. NULL (default)
--      means unlimited: existing workspaces see zero behavior change.
--   2. spend_daily — one row per workspace per local day, incremented by
--      the agentic loop and the model gateway after each completed call.
--      `day` is computed in the workspace's configured timezone so the
--      budget window matches the operator's mental model of "today".
--
-- Both changes are additive and nullable/defaulted — backward-compatible
-- one release per the migration policy (#214).

ALTER TABLE nexaas_memory.workspace_config
  ADD COLUMN IF NOT EXISTS spend_daily_budget_usd NUMERIC;

CREATE TABLE IF NOT EXISTS nexaas_memory.spend_daily (
  workspace   TEXT NOT NULL,
  day         DATE NOT NULL,
  usd         NUMERIC NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace, day)
);
