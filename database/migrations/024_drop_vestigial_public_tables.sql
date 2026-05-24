-- Migration 024: Drop vestigial public.* tables (issue #183, expanded #210)
-- Date: 2026-05-16 (expanded 2026-05-24)
--
-- Five tables in the public schema are 0-row on every healthy worker and have
-- zero writers anywhere in the framework. Live data lives in nexaas_memory.*.
-- They exist as residual from pre-palace deploys. Operators or LLM-assisted
-- ops tooling defaulting to the public schema get a misleading
-- "framework not writing" picture of substrate state.
--
-- Original audit 2026-05-16 against /opt/nexaas at HEAD d44f9c6:
--   grep -rn "public.workspace_skills|INSERT INTO workspace_skills|FROM workspace_skills"
--        packages/ mcp/ integrations/ database/  → only this drop matches
--   grep -rn "public.events|INSERT INTO events|FROM events\b"  (excluding nexaas_memory)
--        → no writers
--   grep -rn "public.agent_memory|agent_memory"
--        → only the CREATE in 009_architecture_v4.sql and this drop
--
-- Update 2026-05-24 (#210): the original drop set omitted public.event_runs
-- and public.job_queue, which hold FKs to public.events:
--
--   conname                  | from_table
--   -------------------------+------------
--   event_runs_event_id_fkey | event_runs
--   job_queue_event_id_fkey  | job_queue
--
-- Without CASCADE, the drop of public.events failed on every affected adopter
-- ("cannot drop table events because other objects depend on it"). Phoenix
-- Voyages hit this on their nexaas upgrade --migrate.
--
-- Both event_runs and job_queue are the same pre-palace residual family —
-- 0 rows on healthy workers, no framework writers. Re-audited 2026-05-24:
--   grep -rn "public.event_runs|FROM event_runs|INSERT INTO event_runs"
--        packages/ mcp/ integrations/ database/  → 0 references
--   grep -rn "public.job_queue|FROM job_queue|INSERT INTO job_queue"
--        packages/ mcp/ integrations/ database/  → 0 references
--
-- Adding them to the drop set in dependency order. Still no CASCADE — the
-- "fail loudly so the operator can investigate" stance is preserved for any
-- FK we haven't enumerated.
--
-- The live equivalents for the original three (workspace_skills, events,
-- agent_memory) and the two FK-holders (event_runs, job_queue):
--   public.workspace_skills  → BullMQ repeat keys
--                              (bull:nexaas-skills-<workspace>:repeat:*)
--   public.events            → nexaas_memory.events
--   public.agent_memory      → nexaas_memory.{closets, entities, facts}
--   public.event_runs        → nexaas_memory.skill_runs
--   public.job_queue         → BullMQ (Redis-backed)
--
-- Modification-in-place rationale (#210): the original 024 never successfully
-- applied on any affected adopter — it failed on the FK violation and rolled
-- back. The single deploy where 024 is recorded as applied (Phoenix Voyages)
-- got there via manual out-of-band drops of event_runs + job_queue followed
-- by re-running nexaas upgrade --migrate. The migration runner tracks
-- schema_migrations by filename (no checksum), so the patched 024 is
-- invisible to deploys where the filename is already recorded. For new
-- affected adopters, the patched drop set applies cleanly in one pass.
--
-- DROP TABLE removes attached indexes automatically. CASCADE remains
-- intentionally omitted.

-- FK-holders drop first (they reference public.events):
DROP TABLE IF EXISTS public.event_runs;
DROP TABLE IF EXISTS public.job_queue;

-- Original three (no remaining inbound FKs after the drops above):
DROP TABLE IF EXISTS public.workspace_skills;
DROP TABLE IF EXISTS public.events;
DROP TABLE IF EXISTS public.agent_memory;
