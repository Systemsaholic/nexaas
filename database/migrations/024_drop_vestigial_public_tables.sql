-- Migration 024: Drop vestigial public.* tables (issue #183)
-- Date: 2026-05-16
--
-- Three tables in the public schema are 0-row on every healthy worker and have
-- zero writers anywhere in the framework. Live data lives in nexaas_memory.*.
-- They exist as residual from pre-palace deploys. Operators or LLM-assisted
-- ops tooling defaulting to the public schema get a misleading
-- "framework not writing" picture of substrate state.
--
-- Audited 2026-05-16 against /opt/nexaas at HEAD d44f9c6:
--   grep -rn "public.workspace_skills|INSERT INTO workspace_skills|FROM workspace_skills"
--        packages/ mcp/ integrations/ database/  → only this drop matches
--   grep -rn "public.events|INSERT INTO events|FROM events\b"  (excluding nexaas_memory)
--        → no writers
--   grep -rn "public.agent_memory|agent_memory"
--        → only the CREATE in 009_architecture_v4.sql and this drop
--
-- The live equivalents are:
--   public.workspace_skills  → BullMQ repeat keys
--                              (bull:nexaas-skills-<workspace>:repeat:*)
--   public.events            → nexaas_memory.events
--   public.agent_memory      → nexaas_memory.{closets, entities, facts}
--
-- DROP TABLE removes attached indexes (idx_agent_memory_dept,
-- idx_agent_memory_type from 009) automatically. CASCADE is intentionally
-- omitted — these tables should have no dependents; if any exist on a given
-- deploy, the migration fails loudly so the operator can investigate rather
-- than silently dropping consumer state.

DROP TABLE IF EXISTS public.workspace_skills;
DROP TABLE IF EXISTS public.events;
DROP TABLE IF EXISTS public.agent_memory;
