# Nexaas v2 Phase 2 — Skill Neuro-Network Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Depends on:** Phase 1 (complete — merged to main)

## Context

Phase 1 established the Trigger.dev execution engine, workspace manifests, orchestrator bootstrap, and battle-tested libs from Phoenix. Phase 2 builds the autonomous skill evolution layer — the "neuro-network" that lets skills improve themselves, failures escalate across workspaces, and fixes propagate automatically.

## Architecture Overview

```
Client VPS (isolated, own Trigger.dev)         Core VPS (Nexaas repo)
┌──────────────────────────────┐               ┌──────────────────────────────┐
│ Skill executes via run-skill │               │                              │
│         │                    │               │                              │
│         ▼                    │               │                              │
│ SKILL_IMPROVEMENT_CANDIDATE  │               │                              │
│ detected in output           │               │                              │
│         │                    │               │                              │
│         ▼                    │               │                              │
│ feedback/collector.ts        │               │                              │
│ writes to local skill_feedback│              │                              │
│         │                    │               │                              │
│         ▼                    │               │                              │
│ feedback/sanitizer.ts        │               │                              │
│ 2-pass contamination scan    │               │                              │
│         │                    │               │                              │
│         ▼                    │               │                              │
│ [stored locally, awaiting    │  ──webhook──▶ │ receive-escalation.ts        │
│  core sweep or escalation]   │  (on failure) │ writes to core skill_feedback│
│                              │               │         │                    │
│ context/store.ts             │               │         ▼                    │
│ conversation persistence     │               │ scan-workspaces.ts           │
│ (local, per-thread)          │               │ SSH sweep every 6h           │
│                              │               │ pulls feedback + failures    │
│                              │               │         │                    │
│                              │               │         ▼                    │
│                              │               │ diagnose-failure.ts          │
│                              │               │ correlates across workspaces │
│                              │               │         │                    │
│                              │               │         ▼                    │
│                              │               │ proposal-generator.ts        │
│                              │               │ creates skill_proposal       │
│                              │               │         │                    │
│                              │               │         ▼                    │
│                              │               │ dependency-checker.ts        │
│                              │               │ workspace compatibility      │
│                              │               │         │                    │
│                              │               │         ▼                    │
│                              │               │ human-gate.ts                │
│                              │               │ Telegram notification        │
│                              │               │ [Approve] [Reject]           │
│                              │               │         │                    │
│                              │               │         ▼ (on approve)       │
│                              │               │ sync/propagator.ts           │
│                              │  ◀──rsync───  │ pushes skill to clients      │
│ skill updated on disk        │  (via SSH)    │ via SSH + rsync              │
│ next run uses new version    │               │         │                    │
│                              │               │         ▼                    │
│                              │               │ version-router.ts            │
│                              │               │ respects pinned versions     │
│                              │               │ git commit + push            │
└──────────────────────────────┘               └──────────────────────────────┘
```

## Topology

Every VPS — including the core — runs its own full Trigger.dev stack (webapp + postgres + redis + worker). There is no shared Trigger.dev instance. Each is fully independent. Communication between core and clients is via **SSH** (push/pull) and **webhooks** (real-time failure escalation).

```
Core VPS (Nexaas orchestrator)
├── Trigger.dev (self-hosted)     ← orchestration tasks
│   ├── scan-workspaces           (SSH sweep every 6h)
│   ├── receive-escalation        (webhook listener)
│   ├── diagnose-failure          (Claude correlates failures)
│   ├── check-approvals           (polls DB for approved proposals)
│   └── sync-skills               (rsync to clients on approval)
├── Postgres                      ← core DB (proposals, aggregated feedback)
├── Redis
├── Nexaas repo (/opt/nexaas)     ← source of truth for skills
├── SSH → Client A VPS
├── SSH → Client B VPS
└── SSH → Client C VPS

Client VPS (per client — fully isolated)
├── Trigger.dev (self-hosted)     ← client workload tasks
│   ├── run-skill                 (skill execution)
│   ├── run-agent                 (agent execution)
│   ├── cron-tasks                (scheduled shell tasks)
│   └── self-heal                 (local failure recovery)
├── Postgres                      ← client DB (feedback, contexts, local state)
├── Redis
└── Workspace data
```

The core's Trigger.dev runs orchestration tasks only (scanning, diagnosing, approving, syncing). Client Trigger.dev instances run business workload tasks only (skills, agents, crons). They never cross.

---

## 1. Feedback Capture (runs on client VPS)

### 1.1 orchestrator/feedback/collector.ts

Captures feedback signals from skill execution output.

**Signals captured:**

| Signal | Source | Trigger |
|---|---|---|
| `skill_improvement` | SKILL_IMPROVEMENT_CANDIDATE marker in Claude output | Automatic during run-skill |
| `execution_failure` | Task failure after self-heal fails | onFailure handler |
| `user_feedback` | Manual feedback via API/dashboard | Future — Phase 3 |

**Interface:**

```typescript
interface FeedbackSignal {
  skillId: string;
  workspaceId: string;
  sessionId?: string;
  signal: "skill_improvement" | "execution_failure" | "user_feedback";
  evidence: {
    rawOutput?: string;       // The marker text or error message
    errorStack?: string;      // Stack trace for failures
    selfHealAttempt?: string; // What self-heal tried
    runId?: string;           // Trigger.dev run ID
  };
  claudeReflection?: string;  // The improvement description
  collected: boolean;          // Has core pulled this yet?
  createdAt: Date;
}
```

**How it integrates with run-skill.ts:**

The existing `run-skill.ts` already scans Claude output for `SKILL_IMPROVEMENT_CANDIDATE`. Phase 2 adds an import of `FeedbackCollector.capture()` and calls it when the marker is detected. For failures, the `trigger.config.ts` onFailure handler calls `FeedbackCollector.captureFailure()` after self-heal fails.

**Storage:** Writes to the client's local `skill_feedback` Postgres table (schema already exists from Phase 1).

### 1.2 orchestrator/feedback/sanitizer.ts

Two-pass contamination scan. Runs on the client before feedback is stored.

**Pass 1 — Regex scan:**
- PII patterns: email addresses, phone numbers, SSNs
- Credentials: API keys (`sk-`, `ghp_`, `Bearer`, `token=`)
- Client names: loaded dynamically from workspace manifest `name` field
- Absolute paths: `/home/ubuntu/ClientName/`, `/opt/workspaces/`
- Domains: loaded from workspace manifest (inferred from MCP email configs)

**Pass 2 — Claude Haiku semantic scan:**
- Only runs on signals that Pass 1 flags as `ambiguous` (not clearly clean or clearly contaminated)
- Prompt: "Does this text contain any client-specific information? Respond YES or NO with explanation."
- Saves tokens by skipping obviously clean or obviously contaminated signals

**Output:**

```typescript
interface SanitizationResult {
  status: "clean" | "flagged";
  originalText: string;
  cleanedText?: string;       // With violations redacted
  violations?: Array<{
    type: string;             // "pii" | "credential" | "client_name" | "path" | "domain"
    match: string;
    position: number;
  }>;
  pass1Result: "clean" | "flagged" | "ambiguous";
  pass2Result?: "clean" | "flagged";
  reviewerSummary?: string;   // Haiku's explanation (Pass 2 only)
}
```

**Behavior:** Never silently blocks. Flagged signals are stored with `violations` attached — the core decides what to do with them during the sweep. Clean signals are stored as-is.

---

## 2. Failure Escalation (client → core)

### 2.1 Client-side: orchestrator/feedback/escalation.ts

Lightweight webhook push when self-heal fails.

**Trigger:** `trigger.config.ts` onFailure → self-heal task returns `{ healed: false }` → `escalate()` called.

**Payload:**

```typescript
interface EscalationPayload {
  workspaceId: string;
  skillId?: string;
  taskId: string;
  error: string;
  selfHealAttempt: string;
  runId: string;
  timestamp: string;
}
```

**Transport:** HTTP POST to core VPS endpoint. URL configured via `NEXAAS_CORE_WEBHOOK_URL` env var on each client. Falls back gracefully — if the webhook fails (core down, network issue), the escalation is still captured locally in `skill_feedback` and will be picked up by the scheduled sweep.

**Cost:** Zero tokens. Just an HTTP POST. No Claude involved.

### 2.2 Core-side: trigger/tasks/receive-escalation.ts

A lightweight HTTP endpoint on the core VPS (Hono or Express, minimal).

**On receive:**
1. Validate payload (zod schema)
2. Write to core's `skill_feedback` table (signal: `escalation`)
3. Check correlation: query `skill_feedback` for same `skillId` with signal `escalation` or `execution_failure` in the last 24 hours across different workspaces
4. If correlated (2+ workspaces, same skill, similar error): trigger `diagnose-failure` task
5. If isolated (1 workspace): log + Telegram alert ("Phoenix Voyages: email-triage failed, self-heal unsuccessful")

### 2.3 Core-side: trigger/tasks/diagnose-failure.ts

Claude Sonnet analyzes correlated failures.

**Input:** All failure records for the skill across workspaces (from skill_feedback table).

**Process:**
1. Read the skill's `prompt.md` and `skill.yaml` from the repo
2. Prompt Claude: "This skill failed on N workspaces with these errors: [...]. Analyze the root cause and propose a fix to the skill's prompt or configuration."
3. Claude outputs: root cause diagnosis + proposed change to prompt.md or skill.yaml

**Output:**
- If fixable: creates a `skill_proposal` in the DB → enters promotion pipeline (Section 3)
- If not fixable (infrastructure issue, auth, etc.): Telegram alert with full diagnosis and recommended manual action

### 2.4 Core-side: trigger/tasks/scan-workspaces.ts

Scheduled SSH sweep — belt and suspenders alongside webhooks.

**Schedule:** Every 6 hours.

**Process:**
1. Read all workspace manifests from `workspaces/*.workspace.json`
2. For each workspace with an SSH-accessible VPS:
   - SSH in, query `skill_feedback WHERE collected = false`
   - Pull back uncollected feedback signals
   - Mark pulled records as `collected = true` on the client
3. Write pulled signals to core's `skill_feedback` table
4. Run correlation check (same as receive-escalation step 3)
5. For clean improvement signals: feed into proposal generator

**SSH access:** Uses the same SSH keys already configured for `provision-workspace.sh`. The VPS IP is derived from workspace manifest's `trigger.workerUrl` or a new `ssh` field.

**Workspace manifest addition:**

```json
{
  "ssh": {
    "host": "203.0.113.50",
    "user": "ubuntu",
    "port": 22
  }
}
```

---

## 3. Promotion Pipeline (runs on core)

### 3.1 orchestrator/promotion/proposal-generator.ts

Creates structured proposals from feedback signals or failure diagnoses.

**Input:** A sanitized feedback signal (improvement or failure fix).

**Process:**
1. Look up current skill version from `skills/_registry.yaml`
2. Determine version bump:
   - Improvement signals: minor bump (1.0.0 → 1.1.0)
   - Failure fixes: patch bump (1.0.0 → 1.0.1)
3. Write to `skill_proposals` table:
   - `skill_id`, `workspace_id` (source), `from_version`, `proposed_version`
   - `proposed_improvement` (the change description)
   - `status: "pending"`
   - `pass1_clean` / `pass2_clean` from sanitization
   - `violations` if any (for review)

### 3.2 orchestrator/promotion/dependency-checker.ts

Checks workspace compatibility before a skill update can be deployed.

**Input:** skill ID + proposed version.

**Process:**
1. Read the skill's `skill.yaml` for required MCP servers and capabilities
2. Read all workspace manifests that subscribe to this skill
3. For each workspace, check:
   - Does it have all required MCP servers in its `mcp` section?
   - Does it have all required capabilities (`playwright`, `docker`, etc.)?
4. Return compatibility report:

```typescript
interface CompatibilityReport {
  skillId: string;
  proposedVersion: string;
  compatible: Array<{ workspaceId: string; name: string }>;
  incompatible: Array<{
    workspaceId: string;
    name: string;
    missing: string[];  // e.g., ["playwright", "mcp:email"]
  }>;
}
```

### 3.3 orchestrator/promotion/human-gate.ts

Notifies you via Telegram and waits for approval.

**Notification content:**
- Skill ID + version bump (e.g., `msp/email-triage 1.0.0 → 1.1.0`)
- Change type: "improvement" or "fix"
- Source: which workspace(s) triggered this
- Proposed change description
- Compatibility: "Will deploy to: phoenix-voyages, acme-corp. Skipped: client-x (no playwright)"
- Buttons: [Approve] [Reject]

**Approval mechanism:**
- Telegram inline keyboard buttons via the Telegram bridge (already exists on Phoenix)
- Button callback writes to `skill_proposals` table: `status = "approved"` or `status = "rejected"`
- A polling task on the core checks for approved proposals every 5 minutes and triggers sync
- Timeout: 7 days — proposal expires to `status = "expired"` if no response

**No Trigger.dev waitpoint** — each client has its own Trigger.dev instance, and the approval happens on the core. Instead, the flow is:
1. Human-gate sends Telegram notification
2. Telegram bot callback (via bridge) writes approval to DB
3. A scheduled `check-approvals` task runs every 5 min, picks up approved proposals, triggers sync

---

## 4. Sync Layer (core → clients)

### 4.1 orchestrator/sync/propagator.ts

Pushes approved skill updates to subscribed workspaces via SSH + rsync.

**Process:**
1. Read approved proposal from `skill_proposals`
2. Read compatibility report from dependency-checker
3. For each compatible workspace:
   - Resolve version (see version-router)
   - `rsync -av --delete skills/{category}/{skill}/ {user}@{host}:/opt/nexaas/skills/{category}/{skill}/`
   - SSH in and run: `psql -c "INSERT INTO skill_versions ..."` to record on client
4. Update `skills/_registry.yaml` with new version number
5. Update `skill_versions` table on core
6. Git commit: `git add skills/ && git commit -m "promote: {skillId} v{version}"` and push
7. Update `skill_proposals` status to `"deployed"`
8. Telegram confirmation: "Synced msp/email-triage v1.1.0 to 3 workspaces"

### 4.2 orchestrator/sync/version-router.ts

Handles version pinning for gradual rollouts.

**Resolution order:**
1. Check `workspace_skills` table for `pinned_version` for this workspace + skill
2. If pinned: sync that specific version (from git history or version archive)
3. If not pinned: sync latest stable version

**Use case:** Pin `acme-corp` to v1.0.0 while testing v1.1.0 on `phoenix-voyages`. Once validated, unpin to roll out everywhere.

### 4.3 trigger/tasks/sync-skills.ts

Already exists as stub. Phase 2 fills it in as the orchestration task:
1. Called by `check-approvals` when a proposal is approved
2. Runs dependency-checker → propagator → version-router
3. Reports results via Telegram
4. Handles partial failures (e.g., one workspace SSH failed): retries that workspace, doesn't block others

---

## 5. Context Store (runs on client VPS)

### 5.1 orchestrator/context/store.ts

Conversation persistence across task runs. Already stubbed — Phase 2 implements it.

**Storage:** Client's local `conversation_contexts` Postgres table (schema exists from Phase 1).

**Interface:**

```typescript
// Load context for a thread (returns null if not found or expired)
loadConversationContext(threadId: string): Promise<ConversationContext | null>

// Save/update context after a task run
saveConversationContext(threadId: string, context: Partial<ConversationContext>): Promise<void>

// Clean up expired contexts
cleanupExpiredContexts(): Promise<number>  // returns count deleted
```

**Windowed context:** When turns exceed the configured max, older turns are summarized:
1. Take turns older than the window (all but last 5)
2. Send to Claude Haiku: "Summarize this conversation history in 2-3 sentences"
3. Store summary in `summary` field
4. Keep only last 5 turns as full text in `turns` array
5. Old turns are not deleted — they move to an `archivedTurns` JSONB field for audit

### 5.2 orchestrator/context/thread-resolver.ts

Extracts thread ID from different source types.

```typescript
function resolveThreadId(source: string, sourceData: Record<string, unknown>): string | undefined {
  switch (source) {
    case "email":
      return sourceData.messageId as string || sourceData.threadId as string;
    case "webhook":
      return sourceData.correlationId as string || sourceData.requestId as string;
    case "manual":
      return sourceData.threadId as string;
    case "schedule":
      return undefined;  // Scheduled tasks don't have threads
    default:
      return undefined;
  }
}
```

### 5.3 TTL Resolution

Context TTL cascades — first match wins:

```
1. Per-skill override   → skill.yaml context.threadTtlDays (e.g., 30)
2. Workspace override   → workspace.json context.threadTtlDays (e.g., 180)
3. Global default       → 90 days
```

Same cascade for `maxTurnsBeforeSummary`:

```
1. Per-skill override   → skill.yaml context.maxTurnsBeforeSummary (e.g., 5)
2. Workspace override   → workspace.json context.maxTurnsBeforeSummary (e.g., 15)
3. Global default       → 10
```

**Cleanup:** A scheduled task (`cleanup-contexts`) runs daily on each client, deletes contexts where `updated_at + ttl < now()`.

### 5.4 Integration with run-skill.ts

Before execution:
```typescript
const context = await loadConversationContext(threadId);
if (context?.summary) {
  prompt = `Previous context: ${context.summary}\n\nRecent:\n${formatTurns(context.turns)}\n\n---\n\n${prompt}`;
}
```

After execution:
```typescript
await saveConversationContext(threadId, {
  workspaceId,
  skillId,
  turns: [...existingTurns, { role: "user", content: prompt }, { role: "assistant", content: output }],
});
```

---

## Database

All tables already exist from Phase 1 (`database/schema.sql`):
- `skill_feedback` — feedback signals (local on client + aggregated on core)
- `skill_proposals` — improvement/fix proposals (core only)
- `skill_versions` — version history (core + local on client)
- `workspace_skills` — subscription + version pins (core)
- `conversation_contexts` — thread state (local on client only)

**New column needed on skill_feedback:**

```sql
ALTER TABLE skill_feedback ADD COLUMN collected BOOLEAN DEFAULT FALSE;
```

**New field on workspace manifests:**

```json
"ssh": {
  "host": "203.0.113.50",
  "user": "ubuntu",
  "port": 22
}
```

---

## Environment Variables (new for Phase 2)

**On client VPSes (.env):**
```bash
NEXAAS_CORE_WEBHOOK_URL=https://core.nexmatic.com/api/escalate
```

**On core VPS (.env):**
```bash
ESCALATION_PORT=8450          # Port for the escalation webhook listener
TELEGRAM_BRIDGE_URL=http://127.0.0.1:8420
SCAN_INTERVAL_HOURS=6         # SSH sweep frequency
APPROVAL_CHECK_MINUTES=5      # How often to check for approved proposals
```

---

## New Files Summary

### On client VPS (deployed via sync)

| File | Purpose |
|---|---|
| `orchestrator/feedback/collector.ts` | Captures feedback signals from skill output |
| `orchestrator/feedback/sanitizer.ts` | 2-pass contamination scan |
| `orchestrator/feedback/escalation.ts` | Webhook push to core on failure |
| `orchestrator/context/store.ts` | Conversation persistence (fill stub) |
| `orchestrator/context/thread-resolver.ts` | Extract thread ID from source data |

### On core VPS

| File | Purpose |
|---|---|
| `trigger/tasks/receive-escalation.ts` | HTTP endpoint for failure webhooks |
| `trigger/tasks/diagnose-failure.ts` | Claude analyzes correlated failures |
| `trigger/tasks/scan-workspaces.ts` | Scheduled SSH sweep of all clients |
| `trigger/tasks/check-approvals.ts` | Polls for approved proposals, triggers sync |
| `trigger/tasks/sync-skills.ts` | Fill existing stub — orchestrates full sync |
| `orchestrator/promotion/proposal-generator.ts` | Creates proposals from feedback |
| `orchestrator/promotion/dependency-checker.ts` | Workspace compatibility check |
| `orchestrator/promotion/human-gate.ts` | Telegram notification + approval |
| `orchestrator/sync/propagator.ts` | Rsync skills to client VPSes |
| `orchestrator/sync/version-router.ts` | Version pinning resolution |

### Modified files

| File | Change |
|---|---|
| `trigger/tasks/run-skill.ts` | Import collector, call capture on SKILL_IMPROVEMENT_CANDIDATE |
| `trigger/trigger.config.ts` | Add escalation call in onFailure when self-heal fails |
| `database/schema.sql` | Add `collected` column to skill_feedback |
| `workspaces/*.workspace.json` | Add `ssh` field |
| `.env.example` | Add new env vars |

---

## Success Criteria

Phase 2 is complete when:
- [ ] Skill improvement signal captured and sanitized on client VPS
- [ ] Failure escalation webhook fires from client → core
- [ ] Core SSH sweep pulls uncollected feedback from all clients
- [ ] Correlated failures across workspaces trigger diagnosis
- [ ] Diagnosis produces a skill proposal in the DB
- [ ] Telegram notification sent with Approve/Reject buttons
- [ ] Approval triggers rsync of updated skill to all compatible workspaces
- [ ] Version pinning prevents rollout to pinned workspaces
- [ ] Git commit + push after skill promotion
- [ ] Conversation context persists across task runs on same thread
- [ ] Context TTL cascades: skill → workspace → global default
- [ ] Expired contexts cleaned up automatically
