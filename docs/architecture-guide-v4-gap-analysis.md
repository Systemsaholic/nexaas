# Architecture Guide v4 — Gap Analysis vs Current Codebase

**Date:** 2026-04-06
**Baseline:** Architecture Guide v4.0 (April 2026)

---

## Major New Concepts Not In Codebase

### 1. Agent Identity Framework (§4) — NEW
**Status: NOT IMPLEMENTED**

Three identity documents per client:
- `brand-voice.md` — business communication style
- `[dept]-operations.md` — department-specific processes
- `agent-handbook.md` — business culture, key people, non-negotiables

We have: Instance CLAUDE.md (platform instructions). We don't have: client-authored identity documents that define the agent's character.

**Gap:** No Foundation Skill interview, no identity doc generation, no identity docs loaded into CAG.

### 2. SOPs and Runbooks (§5) — NEW
**Status: PARTIALLY IMPLEMENTED**

Two procedure types:
- `[skill].sop.md` — Universal, Nexaas-authored, shipped with skill
- `[skill].runbook.md` — Client-specific, co-authored via Foundation Skill

We have: `system-prompt.hbs` (Handlebars template) per skill. We don't have: separate SOP files or client runbooks. The prompt template partially serves as the SOP but doesn't separate universal procedure from client-specific steps.

**Gap:** No `.sop.md` files, no `.runbook.md` files, no Foundation Skill to generate them.

### 3. Channel Registry (§6) — NEW
**Status: NOT IMPLEMENTED**

Two-level registry:
- Orchestrator-level: channel type definitions + operator channels
- Instance-level: actual endpoints, credentials, capabilities per client

Skills declare channel REQUIREMENTS (not channel IDs). Registry resolver finds the right channel per user preference.

We have: MCP server registry (tool bridges). We don't have: channel registry, channel contracts, requirement-based resolution, per-user preferences, fallback chains.

**Gap:** Complete channel subsystem missing. Currently skills can't deliver output to clients through their preferred channels.

### 4. Feedback System (§7) — NEW
**Status: PARTIALLY IMPLEMENTED**

Three feedback sources:
- Agent self-feedback (DOM verify, API confirmation)
- User feedback (approval gates with delta capture)
- Operator feedback (skill quality reviews)

We have: `skill_feedback` table, SKILL_IMPROVEMENT_CANDIDATE marker, pending_approvals with Trigger.dev waitpoints. We don't have: `feedback_events` table (spec structure), delta capture (diff between Claude output and human edit), agent self-feedback loops, operator feedback workflow.

**Gap:** feedback_events table not created. Delta capture not implemented. Agent self-feedback not implemented.

### 5. HEARTBEAT (§12) — NEW
**Status: NOT IMPLEMENTED**

Proactive autonomous scheduling per department:
- Sales daily standup, weekly pipeline review
- Marketing content calendar, social queue check
- Accounting cashflow alerts, month-end close
- Customer service queue check, CSAT reports

Uses Trigger.dev `schedules.task()` with IANA timezone + `externalId` for client identity.

We have: Trigger.dev scheduled tasks (health collection, maintenance). We don't have: per-department HEARTBEAT schedules, `provisionClientHeartbeats()`, silence-if-nothing conditions.

**Gap:** No department schedules, no HEARTBEAT provisioning, no memory continuity between runs.

### 6. Foundation Skill (§4.2) — NEW
**Status: NOT IMPLEMENTED**

First skill for every new client — guided interview that generates:
- brand-voice.md
- [dept]-operations.md
- agent-handbook.md
- Behavioral contract
- Data contract
- Channel registry entries
- User preferences

We have: Manual onboarding questions per skill. We don't have: a unified Foundation Skill that generates all identity docs + contracts from one conversation.

**Gap:** Complete Foundation Skill missing.

### 7. N8N for Event Routing (§2.2) — ARCHITECTURAL CONFLICT
**Status: DECIDED AGAINST**

The spec lists N8N for webhooks and channel event handling. We decided to NOT use N8N — Trigger.dev handles everything. This is documented in our memory as a deliberate decision.

**Action needed:** Discuss with stakeholder whether N8N should be reintroduced for channel event handling specifically, or if Trigger.dev webhook tasks cover this.

---

## Concepts That Changed vs Our Implementation

### 8. CAG — Expanded Significantly (§8)

**Old spec:** Three layers (behavioral, live state, workflow state)
**New spec:** Three LEVELS (Central, Workspace, Skill) + Agent Identity docs included

New additions:
- `brandVoice`, `deptOperations`, `agentHandbook` as full prose in ClientContext
- `skillSop` and `clientRunbook` in context
- `resolvedChannels` from Channel Registry
- `userPreferences` from Postgres

**Our implementation:** `buildCagContext()` loads YAML profile + input. Missing: identity docs, SOPs, runbooks, resolved channels, user preferences.

### 9. TAG — Trigger.dev Mechanisms Specified (§11)

**New detail:** Each TAG route now maps to a specific Trigger.dev mechanism:
- `auto_execute` → direct execution
- `notify_after` → Channel Registry call (NOT just activity_log)
- `approval_required` → `wait.forToken()` (we have this ✓)
- `escalate` → Channel Registry + new task
- `flag` → `wait.forToken()` + operator alert

**Our implementation:** `determineTagRoute()` returns a string. Only `approval_required` actually suspends. Others just log differently.

### 10. Contracts — Channel Requirements Added (§10)

**New addition:** Skill contracts now include `channel-requirements`:
```yaml
channel-requirements:
  approval: { direction: two-way, capabilities: [interactive-buttons] }
  alert:    { direction: two-way, criticality: mission-critical }
  digest:   { direction: one-way, capabilities: [markdown] }
```

**Our implementation:** Contracts have `mcp_servers` but no `channel-requirements`.

### 11. Skill Package Structure — SOP Added

**New spec:** Each skill includes:
- `contract.yaml` ✓ (we have)
- `system-prompt.hbs` ✓ (we have, but spec now calls for identity docs + SOP in prompt)
- `tag-routes.yaml` ✓ (we have)
- `rag-config.yaml` ✓ (we have)
- `onboarding-questions.yaml` ✓ (we have)
- `[skill].sop.md` ✗ (NEW — universal procedure)
- Feedback gate declarations in SOP ✗ (NEW)

---

## What We Have That Aligns Well

| Our Implementation | Spec Alignment |
|---|---|
| `executeSkill()` enforcing contract MCP servers | ✓ Strong — contracts enforced at runtime |
| Trigger.dev `wait.forToken()` for approvals | ✓ Exact match to spec §3.2 |
| Skill feedback → sanitize → propose → approve → propagate | ✓ Matches skill improvement pipeline |
| Workspace manifests with SSH + network config | ✓ Matches two-layer topology |
| Instance CLAUDE.md with architecture context | ✓ Partial match — needs identity doc expansion |
| Client dashboard with approvals, activity, preferences | ✓ Maps to Nexmatic portal concept |
| Skills honing (feedback, rules, knowledge) | ✓ Maps to client-level feedback refinement |
| OVH + Cloudflare automated deployment | ✓ Supports instance provisioning |
| Health monitoring + maintenance cron | ✓ Supports operational reliability |

---

## Priority Implementation Order

### Sprint 1: Foundation
1. **Create `feedback_events` table** — spec §7.3 schema
2. **Define `ClientContext` TypeScript interface** — spec §8.2
3. **Create Agent Identity document templates** — brand-voice.md, operations.md, agent-handbook.md
4. **Add `.sop.md` to email-triage skill** — first universal procedure

### Sprint 2: Channels + TAG
5. **Design Channel Registry schema** — channel contracts, instance registry, Postgres tables
6. **Implement channel resolver** — requirement-based, user preference lookup
7. **Wire TAG routes to real actions** — notify_after sends via channel, escalate routes to person

### Sprint 3: HEARTBEAT + Foundation Skill
8. **Build HEARTBEAT provisioning** — per-department schedules with `externalId`
9. **Build Foundation Skill v1** — guided interview generating identity docs + contracts
10. **Wire identity docs into CAG** — load prose into ClientContext

### Sprint 4: Feedback + RAG
11. **Implement delta capture** — diff between Claude output and human edit
12. **Agent self-feedback** — verify step in SOPs
13. **Qdrant RAG integration** — per-client namespaces

---

## Questions for Stakeholder

1. **N8N:** The spec lists N8N for event routing and channel handling. We decided against N8N. Should we reintroduce it for channel-specific webhooks (WhatsApp, Teams, etc.) or build webhook handlers in Trigger.dev?

2. **Channel implementations timeline:** Which channels first? Email is built (MCP). Slack, WhatsApp, SMS, Teams, Portal — what order?

3. **Foundation Skill:** Should this be a Claude Code interactive conversation, a structured form wizard in the client dashboard, or a hybrid?

4. **HEARTBEAT departments:** Which departments to enable first for the test clients (Fairway, Broken Stick Brewery)?

5. **Memory persistence:** The spec calls for `agent_memory` table with `openItems` and `lastSessionSummary`. Should this replace or extend our existing `conversation_contexts` table?
