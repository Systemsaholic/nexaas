# Architecture Guide v4 — Implementation Plan

**Date:** 2026-04-06
**Status:** Approved decisions, ready for implementation
**Baseline:** Architecture Guide v4.0 + stakeholder decisions

---

## Decisions Made

| Question | Decision |
|----------|----------|
| N8N | NOT architecture. Just an integration tool. Channel Registry resolves to any implementation. |
| Channels | Three categories: Email, Chat, Dashboard. Specific tech is implementation detail. |
| Foundation Skill | All three interfaces: Claude Code terminal, form wizard, AI chat portal. Same output. |
| HEARTBEAT | All department templates available. Foundation Skill activates relevant ones per client. |
| Memory | New `agent_memory` table. Three distinct tables: activity_log, conversation_contexts, agent_memory. |

---

## Data Model

### Three Memory Tables (no overlap)

```
ACTIVITY_LOG (what happened — immutable audit trail)
├── Every action taken, every TAG route
├── "The AI classified this email as billing"
├── "The AI sent this invoice reminder"
└── Never modified, append-only

CONVERSATION_CONTEXTS (thread memory — expires via TTL)
├── Per-thread state across task runs
├── Email thread continuity
├── "Last 5 turns in this email chain"
└── TTL cascade: skill → workspace → 90 days default

AGENT_MEMORY (department memory — persistent, grows over time)
├── Per-department, per-client
├── Open items, pending tasks, patterns
├── "3 overdue invoices being tracked"
├── "Sarah prefers morning emails"
├── "Last weekly review covered X"
├── Carries forward between HEARTBEAT runs
└── Never expires
```

### New Tables Needed

```sql
-- Agent persistent memory (per department, per client)
CREATE TABLE agent_memory (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  department TEXT NOT NULL,           -- sales, marketing, accounting, cs, hr, it, seo
  memory_type TEXT NOT NULL,          -- open_items, session_summary, pattern, preference
  key TEXT NOT NULL,                  -- descriptive key
  value JSONB NOT NULL,               -- structured memory content
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, department, memory_type, key)
);

-- Feedback events (spec §7.3 — all feedback, all sources)
CREATE TABLE feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id TEXT,                    -- Trigger.dev ctx.run.id
  workspace_id TEXT NOT NULL,
  skill_id TEXT,
  gate_id TEXT,                        -- feedback gate ID from SOP/Runbook
  source TEXT NOT NULL,                -- user, agent, operator
  original_output TEXT,                -- what Claude produced
  feedback_type TEXT NOT NULL,         -- approve, reject, edit, timeout, verify-pass, verify-fail
  feedback_value TEXT,                 -- what the human said or agent measured
  edited_output TEXT,                  -- what the human actually sent
  delta JSONB,                         -- computed diff: original vs edited
  downstream_action TEXT,              -- what happened after feedback
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channel Registry (per instance)
CREATE TABLE channel_registry (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,            -- e.g., email-janet, slack-ops, sms-mike
  display_name TEXT NOT NULL,
  direction TEXT NOT NULL,             -- one-way, two-way
  criticality TEXT DEFAULT 'standard', -- mission-critical, standard, fyi
  latency TEXT DEFAULT 'async',        -- realtime, near-realtime, async
  implementation JSONB NOT NULL,       -- { type, server, credential_ref }
  capabilities TEXT[],                 -- markdown, file-attachments, interactive-buttons, threading
  format_constraints JSONB DEFAULT '{}',
  fallback_channel TEXT,               -- channel_id of fallback
  health_check BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, channel_id)
);

-- User channel preferences
CREATE TABLE user_channel_preferences (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_role TEXT,                       -- owner, bookkeeper, manager, etc.
  preference_type TEXT NOT NULL,        -- approval, briefing, urgent, digest
  channel_id TEXT NOT NULL,             -- references channel_registry.channel_id
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_email, preference_type)
);

-- HEARTBEAT schedule registry
CREATE TABLE heartbeat_schedules (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  department TEXT NOT NULL,
  schedule_key TEXT NOT NULL,           -- e.g., daily-standup, weekly-pipeline
  cron TEXT NOT NULL,                   -- cron expression
  timezone TEXT NOT NULL,               -- IANA timezone
  trigger_task_id TEXT NOT NULL,        -- Trigger.dev task ID
  external_id TEXT NOT NULL,            -- clientId:department:scheduleKey
  silence_condition TEXT,               -- "no urgent deals", "queue healthy"
  active BOOLEAN DEFAULT true,
  last_run TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, department, schedule_key)
);

CREATE INDEX idx_agent_memory_dept ON agent_memory(workspace_id, department);
CREATE INDEX idx_feedback_events_run ON feedback_events(task_run_id);
CREATE INDEX idx_feedback_events_skill ON feedback_events(workspace_id, skill_id, created_at DESC);
CREATE INDEX idx_channel_registry_ws ON channel_registry(workspace_id);
CREATE INDEX idx_heartbeat_ws ON heartbeat_schedules(workspace_id, active);
```

---

## Implementation Sprints

### Sprint 1: Data Foundation + Agent Identity + Deploy Upgrade (1 week)

**Database:**
1. Create migration with all new tables (agent_memory, feedback_events, channel_registry, user_channel_preferences, heartbeat_schedules)
2. Apply to orchestrator + all existing instances

**Agent Identity Framework:**
3. Create identity doc templates in `templates/identity/`:
   - `brand-voice.template.md`
   - `operations.template.md`
   - `agent-handbook.template.md`
4. Create directory structure on instances: `/opt/nexaas/identity/`, `/opt/nexaas/runbooks/`
5. Hand-author identity docs for Broken Stick Brewery as first example
6. Update `buildCagContext()` in skill-executor to load identity docs into ClientContext

**Skill SOPs:**
7. Create `email-triage.sop.md` — first universal procedure
8. Create `weather-forecast.sop.md` — test skill procedure
9. Update skill package structure to include `.sop.md`
10. Update `executeSkill()` to load SOP + Runbook into prompt

**ClientContext Interface:**
11. Define `ClientContext` TypeScript interface per spec §8.2
12. Refactor `buildCagContext()` to return typed ClientContext

**Deploy Script Update:**
13. Update `deploy-instance.sh` to include:
    - Install native Postgres + apply full schema (all migrations)
    - Build + install client dashboard as systemd service
    - Create identity doc directories
    - Create default channel registry entry (dashboard channel)
    - Set up Caddy + DNS (if subdomain provided)
    - Install Claude Code + CLAUDE.md + slash commands
    - Register all active skills in workspace_skills
14. Update OVH provisioning route to match deploy-instance.sh
15. Update `maintain-instances.ts` to sync new directories + apply missing migrations

### Sprint 2: Channel Registry + TAG Wiring (1 week)

**Channel Registry:**
16. Create `orchestrator/channels/registry.ts` — channel CRUD + resolver
17. Create `orchestrator/channels/resolver.ts` — requirement-based channel resolution
18. Create channel adapters: `adapters/email.ts`, `adapters/dashboard.ts`, `adapters/chat.ts`
19. Add channel resolution to `executeSkill()` — resolve channels at task start
20. Dashboard channel adapter writes to `pending_approvals` / `activity_log` (existing, enhance)

**TAG Route Wiring:**
21. Update `determineTagRoute()` to use channel delivery:
    - `auto_execute` → execute + audit log (current behavior, keep)
    - `notify_after` → execute + deliver notification via resolved channel
    - `approval_required` → suspend + deliver via two-way channel (current waitpoint, enhance)
    - `escalate` → deliver to escalation target via their preferred channel
    - `flag` → suspend + notify primary contact + operator alert

**Dashboard Integration:**
22. Add Channel Registry management to ops dashboard (instance manage page)
23. Add channel preferences to client dashboard Settings page
24. Update deploy form — add default channel config step

**Dashboard Integration:**
17. Add Channel Registry management to ops dashboard
18. Add channel preferences to client dashboard Settings page

### Sprint 3: Feedback System + Foundation Skill + Onboarding Flow (1-2 weeks)

**Feedback Events:**
25. Create `feedback_events` table writer — called after every approval/rejection
26. Implement delta capture — diff between `original_output` and `edited_output`
27. Wire `executeSkill()` approval flow to write feedback_events
28. Add feedback event display to client dashboard Activity page

**Agent Self-Feedback:**
29. Define self-feedback gate in SOP format
30. Implement verify step in skill-executor — agent checks own output
31. Wire retry loop with Trigger.dev retry policies

**Foundation Skill:**
32. Create Foundation Skill package (`skills/foundation/client-onboarding/`)
33. Implement guided interview flow (Claude-driven conversation)
34. Output: brand-voice.md, operations.md, agent-handbook.md, contracts, channel registry
35. Three interfaces:
    - Claude Code `/foundation` command (ops terminal)
    - Dashboard wizard (ops dashboard, step-by-step)
    - AI chat portal (client dashboard, self-serve)

**Onboarding Flow Redesign:**
36. New end-to-end onboarding sequence:
    ```
    Deploy (Sprint 1 script)
      → Foundation Skill runs (generates identity + contracts + channels)
      → Skills matching integrations auto-activate
      → HEARTBEAT schedules provisioned for active departments
      → Client invite sent (magic link)
      → Client logs in to working system with activity already showing
    ```
37. Add "Run Foundation Skill" button to ops dashboard instance detail
38. Add Foundation Skill AI chat to client dashboard (post-login onboarding wizard)
39. Foundation Skill populates channel_registry with at least email + dashboard
40. Foundation Skill calls `provisionClientHeartbeats()` for selected departments
41. Foundation Skill sets skill statuses: ACTIVE for ready skills, INACTIVE with reasons for others

### Sprint 4: HEARTBEAT + Memory (1 week)

**HEARTBEAT:**
30. Create department HEARTBEAT task templates (sales, marketing, accounting, cs, hr, it, seo)
31. Create `provisionClientHeartbeats()` function
32. Wire to Trigger.dev `schedules.create()` with IANA timezone + externalId
33. Implement silence conditions (skip if nothing to report)

**Agent Memory:**
34. Implement `agent_memory` read/write in skill-executor
35. Load `openItems` and `lastSessionSummary` at task start
36. Write updated memory after task completion
37. Wire HEARTBEAT tasks to use department memory

**Memory Continuity:**
38. Each HEARTBEAT run loads previous session's memory
39. Claude receives: "Last session you noted: [openItems]. Update or close."
40. New openItems + summary written back after each run

### Sprint 5: RAG + Polish (1 week)

**Qdrant RAG:**
41. Deploy Qdrant (Docker) on instances
42. Create per-client namespaces
43. Implement `retrieveRelevantDocs()` with cascade search
44. Wire knowledge uploads (client dashboard) to Qdrant vectorization
45. Inject RAG chunks into ClientContext

**Integration:**
46. End-to-end test: email arrives → skill fires → identity loaded → CAG assembled → RAG retrieved → Claude responds → TAG routes → channel delivers → feedback captured → memory updated
47. Test on Broken Stick Brewery with email-triage skill

---

## File Structure Changes

```
skills/{category}/{name}/
  ├── contract.yaml              (existing ✓)
  ├── system-prompt.hbs          (existing ✓ — update to include identity + SOP slots)
  ├── tag-routes.yaml            (existing ✓)
  ├── rag-config.yaml            (existing ✓)
  ├── onboarding-questions.yaml  (existing ✓)
  ├── {name}.sop.md              (NEW — universal procedure with feedback gates)
  ├── task.ts                    (existing ✓)
  ├── schema.ts                  (existing ✓)
  ├── CHANGELOG.md               (existing ✓)
  └── tests/                     (existing ✓)

templates/identity/
  ├── brand-voice.template.md    (NEW)
  ├── operations.template.md     (NEW)
  └── agent-handbook.template.md (NEW)

templates/heartbeat/
  ├── sales.yaml                 (NEW — schedule templates per department)
  ├── marketing.yaml
  ├── accounting.yaml
  ├── customer-service.yaml
  ├── hr.yaml
  ├── it.yaml
  └── seo.yaml

orchestrator/channels/
  ├── registry.ts                (NEW — channel CRUD)
  ├── resolver.ts                (NEW — requirement-based resolution)
  └── adapters/
      ├── email.ts               (NEW — email channel adapter)
      ├── dashboard.ts           (NEW — Nexmatic portal adapter)
      └── chat.ts                (NEW — generic chat adapter: Slack/Teams/WhatsApp/SMS)

Per-client instance:
  /opt/nexaas/identity/
    ├── brand-voice.md           (generated by Foundation Skill)
    ├── sales-operations.md      (per active department)
    ├── accounting-operations.md
    └── agent-handbook.md

  /opt/nexaas/runbooks/
    ├── email-triage.runbook.md  (client-specific procedures)
    └── ar-reminder.runbook.md
```

---

## Success Criteria

Sprint 1 complete when:
- [ ] All new tables created and migrated (orchestrator + instances)
- [ ] Identity docs exist for Broken Stick Brewery
- [ ] `executeSkill()` loads identity docs + SOP into prompt
- [ ] ClientContext TypeScript interface defined and used
- [ ] `deploy-instance.sh` deploys complete stack (Postgres, client dashboard, Caddy, Claude Code, schema)
- [ ] New instance deployed via dashboard has all directories + schema ready
- [ ] `maintain-instances.ts` syncs new directories + applies missing migrations

Sprint 2 complete when:
- [ ] Channel Registry has at least email + dashboard for Broken Stick Brewery
- [ ] `notify_after` sends notification via resolved channel (not just logs)
- [ ] `escalate` delivers to named person's preferred channel
- [ ] User channel preferences editable in client dashboard
- [ ] Deploy form includes default channel setup

Sprint 3 complete when:
- [ ] feedback_events written on every approval/rejection with delta
- [ ] Foundation Skill generates identity docs + contracts from conversation
- [ ] At least one agent self-feedback gate working (verify step)
- [ ] "Run Foundation Skill" button in ops dashboard instance detail
- [ ] Full onboarding: deploy → Foundation Skill → skills activate → HEARTBEAT → invite sent
- [ ] Client logs into a system with activity already showing

Sprint 4 complete when:
- [ ] Sales daily standup HEARTBEAT running on test instance
- [ ] Agent memory persists between HEARTBEAT runs
- [ ] Silence condition works (skip if nothing to report)
- [ ] `provisionClientHeartbeats()` creates schedules from Foundation Skill output

Sprint 5 complete when:
- [ ] Qdrant running on instance, client docs vectorized
- [ ] RAG chunks appear in Claude's context
- [ ] Full E2E: email → classify → approve → send → feedback captured → memory updated
- [ ] Deploy a brand new instance from scratch → Foundation Skill → working system in under 30 minutes
