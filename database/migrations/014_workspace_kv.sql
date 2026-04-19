-- Key-value config store for dynamic workspace settings
-- Used by: plan management, skill config, preferences, rules
-- Complements the column-based workspace_config table (which stores
-- the fixed fields: timezone, display_name, default_model_tier, workspace_root)

CREATE TABLE IF NOT EXISTS nexaas_memory.workspace_kv (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace, key)
);
