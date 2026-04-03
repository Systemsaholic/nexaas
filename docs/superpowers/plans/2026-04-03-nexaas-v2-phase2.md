# Nexaas v2 Phase 2 — Skill Neuro-Network Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the autonomous skill evolution pipeline — feedback capture, failure escalation, promotion with human approval, and sync to client workspaces — plus conversation context persistence.

**Architecture:** Client VPSes capture feedback locally, push failures via webhook, and get swept by the core every 6h via SSH. Core correlates, diagnoses, proposes fixes, and syncs approved changes back via rsync over SSH. Each VPS (including core) runs its own independent Trigger.dev instance.

**Tech Stack:** TypeScript, Trigger.dev v4, Postgres (via `pg` driver), Zod, SSH (child_process), rsync, Claude Code CLI

**Spec:** `docs/superpowers/specs/2026-04-03-nexaas-v2-phase2-design.md`

---

## File Map

### New files

| File | Responsibility | Runs on |
|---|---|---|
| `orchestrator/db.ts` | Postgres connection pool + query helper | Both |
| `orchestrator/feedback/collector.ts` | Capture feedback signals to local DB | Client |
| `orchestrator/feedback/sanitizer.ts` | 2-pass contamination scan | Client |
| `orchestrator/feedback/escalation.ts` | Webhook push to core on failure | Client |
| `orchestrator/context/thread-resolver.ts` | Extract thread ID from source data | Client |
| `trigger/tasks/receive-escalation.ts` | HTTP endpoint for failure webhooks | Core |
| `trigger/tasks/diagnose-failure.ts` | Claude analyzes correlated failures | Core |
| `trigger/tasks/scan-workspaces.ts` | SSH sweep of all clients | Core |
| `trigger/tasks/check-approvals.ts` | Polls for approved proposals, triggers sync | Core |
| `orchestrator/promotion/proposal-generator.ts` | Creates proposals from feedback | Core |
| `orchestrator/promotion/dependency-checker.ts` | Workspace compatibility check | Core |
| `orchestrator/promotion/human-gate.ts` | Telegram notification + approval | Core |
| `orchestrator/sync/propagator.ts` | Rsync skills to client VPSes | Core |
| `orchestrator/sync/version-router.ts` | Version pinning resolution | Core |

### Modified files

| File | Change |
|---|---|
| `orchestrator/context/store.ts` | Fill stub with Postgres implementation |
| `orchestrator/bootstrap/manifest-loader.ts` | Add `ssh` field to WorkspaceManifest |
| `trigger/tasks/run-skill.ts` | Import collector, capture SKILL_IMPROVEMENT_CANDIDATE |
| `trigger/trigger.config.ts` | Add escalation call when self-heal fails |
| `trigger/tasks/sync-skills.ts` | Fill stub with full sync orchestration |
| `package.json` | Add `pg` dependency |
| `workspaces/phoenix-voyages.workspace.json` | Add `ssh` field |
| `.env.example` | Add Phase 2 env vars |

---

## Task 1: Add Postgres driver and DB connection module

**Files:**
- Modify: `package.json`
- Create: `orchestrator/db.ts`

- [ ] **Step 1: Install pg driver**

```bash
npm install pg
npm install -D @types/pg
```

- [ ] **Step 2: Create orchestrator/db.ts**

```typescript
/**
 * Postgres connection pool for the orchestrator.
 *
 * Each VPS (client or core) connects to its own local Postgres.
 * Connection string from DATABASE_URL env var.
 */

import { Pool, type QueryResult } from "pg";

let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    _pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json orchestrator/db.ts
git commit -m "feat: add Postgres connection module for orchestrator"
```

---

## Task 2: Create feedback collector

**Files:**
- Create: `orchestrator/feedback/collector.ts`

- [ ] **Step 1: Create orchestrator/feedback/collector.ts**

```typescript
/**
 * Feedback signal collector.
 *
 * Captures skill improvement signals and execution failures,
 * writes them to the local skill_feedback Postgres table.
 * Runs on client VPSes.
 */

import { query } from "../db.js";

export type FeedbackSignal =
  | "skill_improvement"
  | "execution_failure"
  | "escalation"
  | "user_feedback";

export interface FeedbackEvent {
  skillId: string;
  workspaceId: string;
  sessionId?: string;
  signal: FeedbackSignal;
  evidence?: Record<string, unknown>;
  claudeReflection?: string;
  proposedImprovement?: string;
}

export async function captureFeedback(event: FeedbackEvent): Promise<number> {
  const result = await query(
    `INSERT INTO skill_feedback
      (skill_id, workspace_id, session_id, signal, evidence, claude_reflection, proposed_improvement)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      event.skillId,
      event.workspaceId,
      event.sessionId ?? null,
      event.signal,
      event.evidence ? JSON.stringify(event.evidence) : null,
      event.claudeReflection ?? null,
      event.proposedImprovement ?? null,
    ]
  );
  return result.rows[0].id as number;
}

export async function captureSkillImprovement(params: {
  skillId: string;
  workspaceId: string;
  content: string;
  runId?: string;
}): Promise<number> {
  // Extract the improvement description from the marker line
  const marker = "SKILL_IMPROVEMENT_CANDIDATE:";
  const idx = params.content.indexOf(marker);
  const reflection = idx >= 0
    ? params.content.slice(idx + marker.length).trim()
    : params.content;

  return captureFeedback({
    skillId: params.skillId,
    workspaceId: params.workspaceId,
    signal: "skill_improvement",
    evidence: { rawOutput: params.content.slice(0, 2000), runId: params.runId },
    claudeReflection: reflection,
  });
}

export async function captureFailure(params: {
  skillId?: string;
  workspaceId: string;
  taskId: string;
  error: string;
  selfHealAttempt?: string;
  runId: string;
}): Promise<number> {
  return captureFeedback({
    skillId: params.skillId ?? "unknown",
    workspaceId: params.workspaceId,
    signal: "execution_failure",
    evidence: {
      taskId: params.taskId,
      error: params.error.slice(0, 2000),
      selfHealAttempt: params.selfHealAttempt,
      runId: params.runId,
    },
  });
}

/**
 * Get uncollected feedback signals (for core SSH sweep).
 */
export async function getUncollectedFeedback(): Promise<Array<Record<string, unknown>>> {
  const result = await query(
    `SELECT * FROM skill_feedback WHERE collected = false ORDER BY created_at ASC LIMIT 100`
  );
  return result.rows;
}

/**
 * Mark feedback signals as collected (after core pulls them).
 */
export async function markCollected(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE skill_feedback SET collected = true WHERE id = ANY($1)`,
    [ids]
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/feedback/collector.ts
git commit -m "feat: add feedback signal collector"
```

---

## Task 3: Create feedback sanitizer

**Files:**
- Create: `orchestrator/feedback/sanitizer.ts`

- [ ] **Step 1: Create orchestrator/feedback/sanitizer.ts**

```typescript
/**
 * Two-pass contamination scanner for feedback signals.
 *
 * Pass 1: Regex scan for PII, credentials, client names, paths, domains.
 * Pass 2: Claude Haiku semantic scan (only on ambiguous Pass 1 results).
 *
 * Runs on client VPSes before feedback is stored.
 */

import { runClaude } from "../../trigger/lib/claude.js";

export interface Violation {
  type: "pii" | "credential" | "client_name" | "path" | "domain";
  match: string;
  position: number;
}

export interface SanitizationResult {
  status: "clean" | "flagged";
  originalText: string;
  cleanedText?: string;
  violations: Violation[];
  pass1Result: "clean" | "flagged" | "ambiguous";
  pass2Result?: "clean" | "flagged";
  reviewerSummary?: string;
}

// ── Pass 1: Regex patterns ──────────────────────────────────────────────────

const PATTERNS: Array<{ type: Violation["type"]; regex: RegExp }> = [
  // Credentials
  { type: "credential", regex: /sk-[a-zA-Z0-9]{20,}/g },
  { type: "credential", regex: /ghp_[a-zA-Z0-9]{36,}/g },
  { type: "credential", regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi },
  { type: "credential", regex: /token[=:]\s*[a-zA-Z0-9._\-]{20,}/gi },
  { type: "credential", regex: /api[_-]?key[=:]\s*[a-zA-Z0-9._\-]{16,}/gi },
  // PII
  { type: "pii", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g },
  { type: "pii", regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g },
  { type: "pii", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Absolute paths (Linux)
  { type: "path", regex: /\/home\/[a-zA-Z0-9_-]+\/[^\s"']+/g },
  { type: "path", regex: /\/opt\/workspaces\/[^\s"']+/g },
];

function pass1Scan(text: string, clientNames: string[]): {
  result: "clean" | "flagged" | "ambiguous";
  violations: Violation[];
} {
  const violations: Violation[] = [];

  // Regex patterns
  for (const { type, regex } of PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      violations.push({ type, match: match[0], position: match.index });
    }
  }

  // Client name detection
  for (const name of clientNames) {
    if (name.length < 3) continue; // Skip very short names
    const nameRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
    let match;
    while ((match = nameRegex.exec(text)) !== null) {
      violations.push({ type: "client_name", match: match[0], position: match.index });
    }
  }

  // Domain detection from client names
  for (const name of clientNames) {
    const slug = name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
    if (slug.length < 4) continue;
    const domainRegex = new RegExp(`\\b${escapeRegex(slug)}\\.[a-z]{2,}\\b`, "gi");
    let match;
    while ((match = domainRegex.exec(text)) !== null) {
      violations.push({ type: "domain", match: match[0], position: match.index });
    }
  }

  if (violations.length === 0) return { result: "clean", violations };
  // High confidence violations = flagged, otherwise ambiguous
  const highConfidence = violations.some(
    (v) => v.type === "credential" || v.type === "pii"
  );
  return {
    result: highConfidence ? "flagged" : "ambiguous",
    violations,
  };
}

// ── Pass 2: Claude Haiku semantic scan ──────────────────────────────────────

async function pass2Scan(text: string): Promise<{
  result: "clean" | "flagged";
  summary: string;
}> {
  const result = await runClaude({
    prompt: `Analyze this text for client-specific information that should NOT be in a shared skill improvement proposal. Look for: company names, employee names, specific project details, internal URLs, or any data that identifies a specific business.

Text to analyze:
---
${text.slice(0, 1500)}
---

Respond with exactly one line:
CLEAN: [reason] — if the text is generic and safe to share across workspaces
FLAGGED: [reason] — if the text contains client-specific information

Respond with CLEAN or FLAGGED only.`,
    model: "haiku",
    timeoutMs: 30_000,
    mcpServers: [],
  });

  if (!result.success) {
    // If Haiku scan fails, treat as flagged (safe default)
    return { result: "flagged", summary: `Haiku scan failed: ${result.error}` };
  }

  const isFlagged = result.output.toUpperCase().startsWith("FLAGGED");
  return {
    result: isFlagged ? "flagged" : "clean",
    summary: result.output.slice(0, 500),
  };
}

// ── Main sanitize function ──────────────────────────────────────────────────

/**
 * Run contamination scan on feedback text.
 *
 * @param text - The feedback/improvement text to scan
 * @param clientNames - Known client names to check against (from workspace manifests)
 */
export async function sanitize(
  text: string,
  clientNames: string[]
): Promise<SanitizationResult> {
  const { result: p1Result, violations } = pass1Scan(text, clientNames);

  if (p1Result === "clean") {
    return {
      status: "clean",
      originalText: text,
      violations: [],
      pass1Result: "clean",
    };
  }

  if (p1Result === "flagged") {
    return {
      status: "flagged",
      originalText: text,
      cleanedText: redactViolations(text, violations),
      violations,
      pass1Result: "flagged",
    };
  }

  // Ambiguous — run Pass 2
  const { result: p2Result, summary } = await pass2Scan(text);
  return {
    status: p2Result === "clean" ? "clean" : "flagged",
    originalText: text,
    cleanedText: p2Result === "flagged" ? redactViolations(text, violations) : undefined,
    violations,
    pass1Result: "ambiguous",
    pass2Result: p2Result,
    reviewerSummary: summary,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function redactViolations(text: string, violations: Violation[]): string {
  let result = text;
  // Sort by position descending to preserve positions during replacement
  const sorted = [...violations].sort((a, b) => b.position - a.position);
  for (const v of sorted) {
    result =
      result.slice(0, v.position) +
      `[REDACTED:${v.type}]` +
      result.slice(v.position + v.match.length);
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2: Commit**

```bash
git add orchestrator/feedback/sanitizer.ts
git commit -m "feat: add 2-pass contamination sanitizer"
```

---

## Task 4: Create failure escalation (client-side)

**Files:**
- Create: `orchestrator/feedback/escalation.ts`
- Modify: `trigger/trigger.config.ts`

- [ ] **Step 1: Create orchestrator/feedback/escalation.ts**

```typescript
/**
 * Failure escalation — webhook push to core VPS.
 *
 * When self-heal fails on a client, fires a lightweight POST
 * to the core's escalation endpoint. Zero tokens — just HTTP.
 * Falls back gracefully if core is unreachable.
 */

import { logger } from "@trigger.dev/sdk/v3";

const CORE_WEBHOOK_URL = process.env.NEXAAS_CORE_WEBHOOK_URL;

export interface EscalationPayload {
  workspaceId: string;
  skillId?: string;
  taskId: string;
  error: string;
  selfHealAttempt?: string;
  runId: string;
  timestamp: string;
}

export async function escalate(payload: EscalationPayload): Promise<boolean> {
  if (!CORE_WEBHOOK_URL) {
    logger.warn("NEXAAS_CORE_WEBHOOK_URL not configured — escalation skipped");
    return false;
  }

  try {
    const resp = await fetch(CORE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.ok) {
      logger.info(`Escalated failure to core: ${payload.taskId}`);
      return true;
    }

    logger.warn(`Escalation failed (${resp.status}): ${payload.taskId}`);
    return false;
  } catch (err) {
    // Network failure — escalation will be picked up by SSH sweep
    logger.warn(`Escalation webhook unreachable: ${err}`);
    return false;
  }
}
```

- [ ] **Step 2: Update trigger/trigger.config.ts**

Add escalation import and call after self-heal. The modified file should be:

```typescript
import { defineConfig, tasks } from "@trigger.dev/sdk/v3";
import { escalate } from "../orchestrator/feedback/escalation.js";
import { captureFailure } from "../orchestrator/feedback/collector.js";

/** Tasks excluded from self-healing to prevent loops and noise */
const SKIP_SELF_HEAL = [
  "self-heal",
  "sync-skills",
  "scan-workspaces",
  "receive-escalation",
  "diagnose-failure",
  "check-approvals",
];

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
    },
  },
  dirs: ["tasks", "schedules"],
  onFailure: async ({ payload, error, ctx }) => {
    const taskId = ctx.task.id;
    if (SKIP_SELF_HEAL.some(s => taskId.includes(s))) return;

    const workspaceId = process.env.NEXAAS_WORKSPACE || "unknown";
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Record failure locally
    await captureFailure({
      workspaceId,
      taskId,
      error: errorMsg,
      runId: ctx.run.id,
    }).catch(() => {}); // Don't let DB failure block the handler

    // Attempt self-heal
    const healResult = await tasks.triggerAndWait("self-heal", {
      taskId,
      error: errorMsg,
      runId: ctx.run.id,
    }).catch(() => ({ healed: false }));

    // If self-heal failed, escalate to core
    if (!(healResult as any)?.healed) {
      await escalate({
        workspaceId,
        taskId,
        error: errorMsg,
        selfHealAttempt: "self-heal returned healed: false",
        runId: ctx.run.id,
        timestamp: new Date().toISOString(),
      }).catch(() => {}); // Best-effort — SSH sweep is backup
    }
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/feedback/escalation.ts trigger/trigger.config.ts
git commit -m "feat: add failure escalation (webhook + updated onFailure)"
```

---

## Task 5: Wire feedback capture into run-skill.ts

**Files:**
- Modify: `trigger/tasks/run-skill.ts`

- [ ] **Step 1: Add import and capture call**

At the top of `run-skill.ts`, add:
```typescript
import { captureSkillImprovement } from "../../orchestrator/feedback/collector.js";
import { sanitize } from "../../orchestrator/feedback/sanitizer.js";
```

After `runClaude()` returns successfully in the `runCheck` task (around line 97, after `logger.info("Check completed")`), add SKILL_IMPROVEMENT_CANDIDATE detection:

```typescript
    // Scan output for skill improvement signals
    if (result.output && result.output.includes("SKILL_IMPROVEMENT_CANDIDATE")) {
      const workspaceId = process.env.NEXAAS_WORKSPACE || "unknown";
      // Load client names for sanitizer (from workspace manifest name)
      const clientNames = [workspaceId]; // Minimal — core sweep adds more
      const sanitized = await sanitize(result.output, clientNames);
      if (sanitized.status === "clean") {
        await captureSkillImprovement({
          skillId: check.id,
          workspaceId,
          content: result.output,
          runId: check._source_file as string,
        }).catch((err) => logger.warn(`Failed to capture improvement: ${err}`));
      } else {
        logger.warn(`Skill improvement flagged by sanitizer: ${sanitized.violations.length} violations`);
      }
    }
```

- [ ] **Step 2: Commit**

```bash
git add trigger/tasks/run-skill.ts
git commit -m "feat: wire feedback capture into run-skill task"
```

---

## Task 6: Update workspace manifest type and add SSH field

**Files:**
- Modify: `orchestrator/bootstrap/manifest-loader.ts`
- Modify: `workspaces/phoenix-voyages.workspace.json`
- Modify: `.env.example`

- [ ] **Step 1: Add ssh field to WorkspaceManifest interface**

In `orchestrator/bootstrap/manifest-loader.ts`, add to the `WorkspaceManifest` interface after `domainMap`:

```typescript
  ssh?: {
    host: string;
    user: string;
    port?: number;
  };
```

- [ ] **Step 2: Add ssh to phoenix-voyages manifest**

In `workspaces/phoenix-voyages.workspace.json`, add after the `domainMap` field:

```json
  "ssh": {
    "host": "phoenix-services",
    "user": "ubuntu",
    "port": 22
  },
```

- [ ] **Step 3: Update .env.example with Phase 2 vars**

Append to `.env.example`:

```bash

# Phase 2: Neuro-Network
NEXAAS_CORE_WEBHOOK_URL=         # Core escalation endpoint (on clients)
ESCALATION_PORT=8450             # Escalation listener port (on core)
SCAN_INTERVAL_HOURS=6            # SSH sweep frequency (on core)
APPROVAL_CHECK_MINUTES=5         # Proposal approval polling (on core)
```

- [ ] **Step 4: Commit**

```bash
git add orchestrator/bootstrap/manifest-loader.ts workspaces/phoenix-voyages.workspace.json .env.example
git commit -m "feat: add SSH config to workspace manifests"
```

---

## Task 7: Create escalation receiver (core-side)

**Files:**
- Create: `trigger/tasks/receive-escalation.ts`

- [ ] **Step 1: Create the task**

This is a Trigger.dev task that can be invoked via HTTP (Trigger.dev's webhook trigger) or directly. It receives escalation payloads, stores them, and checks for cross-workspace correlation.

```typescript
/**
 * Receives failure escalations from client VPSes.
 *
 * Stores the escalation in the core's skill_feedback table,
 * then checks for correlation: has this skill/task failed on
 * other workspaces recently?
 *
 * If correlated (2+ workspaces): triggers diagnose-failure.
 * If isolated (1 workspace): Telegram alert.
 */

import { task, logger, tasks } from "@trigger.dev/sdk/v3";
import { query } from "../../orchestrator/db.js";
import { notifyTelegram } from "../lib/telegram.js";
import { z } from "zod";

const EscalationSchema = z.object({
  workspaceId: z.string(),
  skillId: z.string().optional(),
  taskId: z.string(),
  error: z.string(),
  selfHealAttempt: z.string().optional(),
  runId: z.string(),
  timestamp: z.string(),
});

export const receiveEscalation = task({
  id: "receive-escalation",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 60,
  run: async (payload: unknown) => {
    const parsed = EscalationSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error("Invalid escalation payload", { errors: parsed.error.issues });
      return { success: false, error: "invalid payload" };
    }

    const esc = parsed.data;
    logger.info(`Escalation from ${esc.workspaceId}: ${esc.taskId}`, {
      error: esc.error.slice(0, 200),
    });

    // Store in core DB
    await query(
      `INSERT INTO skill_feedback
        (skill_id, workspace_id, signal, evidence, created_at)
       VALUES ($1, $2, 'escalation', $3, NOW())`,
      [
        esc.skillId || esc.taskId,
        esc.workspaceId,
        JSON.stringify({
          taskId: esc.taskId,
          error: esc.error,
          selfHealAttempt: esc.selfHealAttempt,
          runId: esc.runId,
        }),
      ]
    );

    // Check correlation: same skill/task failed on other workspaces in last 24h
    const correlationKey = esc.skillId || esc.taskId;
    const correlated = await query(
      `SELECT DISTINCT workspace_id FROM skill_feedback
       WHERE skill_id = $1
         AND signal IN ('escalation', 'execution_failure')
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [correlationKey]
    );

    const affectedWorkspaces = correlated.rows.map((r) => r.workspace_id as string);

    if (affectedWorkspaces.length >= 2) {
      // Cross-workspace correlation — trigger diagnosis
      logger.info(`Correlated failure: ${correlationKey} on ${affectedWorkspaces.length} workspaces`);
      await tasks.trigger("diagnose-failure", {
        skillId: correlationKey,
        workspaces: affectedWorkspaces,
        latestError: esc.error,
      });
      return { success: true, action: "diagnosis-triggered", workspaces: affectedWorkspaces };
    }

    // Isolated failure — alert via Telegram
    await notifyTelegram({
      user: "al",
      type: "alert",
      title: `Failure: ${esc.taskId}`,
      body: `Workspace: ${esc.workspaceId}\nError: ${esc.error.slice(0, 300)}${esc.selfHealAttempt ? `\nSelf-heal: ${esc.selfHealAttempt}` : ""}`,
      priority: "urgent",
    });

    return { success: true, action: "alert-sent" };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add trigger/tasks/receive-escalation.ts
git commit -m "feat: add escalation receiver with cross-workspace correlation"
```

---

## Task 8: Create failure diagnosis task (core-side)

**Files:**
- Create: `trigger/tasks/diagnose-failure.ts`

- [ ] **Step 1: Create the task**

```typescript
/**
 * Diagnoses correlated failures across workspaces.
 *
 * When the same skill fails on 2+ workspaces, Claude Sonnet analyzes
 * the failure patterns and proposes a fix. If fixable, creates a
 * skill_proposal. If not, sends a Telegram alert with diagnosis.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../orchestrator/db.js";
import { runClaude } from "../lib/claude.js";
import { notifyTelegram } from "../lib/telegram.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export const diagnoseFailure = task({
  id: "diagnose-failure",
  queue: { name: "orchestrator", concurrencyLimit: 2 },
  maxDuration: 300, // 5 min — Claude diagnosis
  run: async (payload: {
    skillId: string;
    workspaces: string[];
    latestError: string;
  }) => {
    logger.info(`Diagnosing correlated failure: ${payload.skillId}`, {
      workspaces: payload.workspaces,
    });

    // Gather all failure records for this skill
    const failures = await query(
      `SELECT workspace_id, evidence, created_at FROM skill_feedback
       WHERE skill_id = $1
         AND signal IN ('escalation', 'execution_failure')
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at DESC LIMIT 20`,
      [payload.skillId]
    );

    // Try to read the skill's prompt.md if it exists
    let skillPrompt = "";
    try {
      const promptPath = join(NEXAAS_ROOT, "skills", ...payload.skillId.split("/"), "prompt.md");
      skillPrompt = readFileSync(promptPath, "utf-8").slice(0, 3000);
    } catch {
      skillPrompt = "(skill prompt not found on core)";
    }

    // Build failure summary for Claude
    const failureSummary = failures.rows.map((r) => {
      const ev = typeof r.evidence === "string" ? JSON.parse(r.evidence as string) : r.evidence;
      return `- Workspace: ${r.workspace_id}, Error: ${(ev as any)?.error?.slice(0, 200) || "unknown"}, Time: ${r.created_at}`;
    }).join("\n");

    const result = await runClaude({
      prompt: `You are diagnosing a skill failure that occurred across ${payload.workspaces.length} workspaces.

Skill ID: ${payload.skillId}

Skill prompt (current version):
---
${skillPrompt}
---

Failure records:
${failureSummary}

Latest error: ${payload.latestError}

Analyze the root cause. Is this:
1. A skill bug (fixable by changing the prompt or config)?
2. An infrastructure issue (auth, network, disk)?
3. An external dependency issue (API down, rate limited)?

If it's a skill bug (#1), respond with:
FIX: [description of the change needed to prompt.md or skill.yaml]

If it's infrastructure or external (#2 or #3), respond with:
MANUAL: [description of what needs to be done and on which workspaces]

Keep response under 300 words.`,
      model: "sonnet",
      timeoutMs: 120_000,
      mcpServers: [],
    });

    if (!result.success) {
      logger.error(`Diagnosis failed: ${result.error}`);
      await notifyTelegram({
        user: "al",
        type: "alert",
        title: `Diagnosis Failed: ${payload.skillId}`,
        body: `Could not diagnose failure on ${payload.workspaces.join(", ")}.\nError: ${result.error}`,
        priority: "urgent",
      });
      return { success: false, error: result.error };
    }

    const isFix = result.output.toUpperCase().startsWith("FIX:");

    if (isFix) {
      // Create a skill proposal
      const fixDescription = result.output.slice(4).trim();
      await query(
        `INSERT INTO skill_proposals
          (skill_id, workspace_id, from_version, proposed_version,
           proposed_improvement, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
        [
          payload.skillId,
          payload.workspaces[0], // Source workspace
          "current", // Will be resolved by proposal-generator
          "patch",   // Will be resolved by proposal-generator
          fixDescription,
        ]
      );

      logger.info(`Created fix proposal for ${payload.skillId}`);

      await notifyTelegram({
        user: "al",
        type: "approval",
        title: `Fix Proposed: ${payload.skillId}`,
        body: `Failed on: ${payload.workspaces.join(", ")}\n\nProposed fix:\n${fixDescription.slice(0, 300)}`,
        buttons: [
          { text: "Approve", callback_data: `approve_skill:${payload.skillId}` },
          { text: "Reject", callback_data: `reject_skill:${payload.skillId}` },
        ],
        skipDedup: true,
      });

      return { success: true, action: "proposal-created", fix: fixDescription };
    }

    // Manual intervention needed
    await notifyTelegram({
      user: "al",
      type: "alert",
      title: `Manual Fix Needed: ${payload.skillId}`,
      body: `Workspaces: ${payload.workspaces.join(", ")}\n\n${result.output.slice(0, 500)}`,
      priority: "urgent",
    });

    return { success: true, action: "manual-alert", diagnosis: result.output };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add trigger/tasks/diagnose-failure.ts
git commit -m "feat: add correlated failure diagnosis task"
```

---

## Task 9: Create SSH workspace scanner (core-side)

**Files:**
- Create: `trigger/tasks/scan-workspaces.ts`

- [ ] **Step 1: Create the task**

```typescript
/**
 * Scheduled SSH sweep of all client workspaces.
 *
 * Runs every 6 hours on the core. SSHes into each registered workspace,
 * pulls uncollected feedback signals, and feeds them into the pipeline.
 */

import { task, schedules, logger, tasks } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { query } from "../../orchestrator/db.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { readdirSync } from "fs";
import { join } from "path";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

function getWorkspaceIds(): string[] {
  const dir = join(NEXAAS_ROOT, "workspaces");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

export const scanWorkspaces = task({
  id: "scan-workspaces",
  queue: { name: "orchestrator", concurrencyLimit: 1 },
  maxDuration: 600, // 10 min — SSH to multiple VPSes
  run: async () => {
    const workspaceIds = getWorkspaceIds();
    logger.info(`Scanning ${workspaceIds.length} workspaces`);

    let totalPulled = 0;
    const errors: string[] = [];

    for (const wsId of workspaceIds) {
      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          logger.info(`Skipping ${wsId} — no SSH config`);
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const sshTarget = `${user}@${host}`;
        const sshPort = port || 22;

        // Query uncollected feedback on the client
        const pullResult = await runShell({
          command: `ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${sshTarget} "psql \\$DATABASE_URL -t -A -c \\"SELECT row_to_json(f) FROM (SELECT id, skill_id, workspace_id, signal, evidence, claude_reflection, proposed_improvement, created_at FROM skill_feedback WHERE collected = false ORDER BY created_at LIMIT 50) f\\""`,
          timeoutMs: 30_000,
        });

        if (!pullResult.success) {
          logger.warn(`SSH to ${wsId} failed: ${pullResult.stderr.slice(0, 200)}`);
          errors.push(`${wsId}: ${pullResult.stderr.slice(0, 100)}`);
          continue;
        }

        // Parse JSON rows from psql output
        const rows = pullResult.stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);

        if (rows.length === 0) {
          logger.info(`${wsId}: no uncollected feedback`);
          continue;
        }

        logger.info(`${wsId}: pulled ${rows.length} feedback signals`);

        // Insert into core DB
        for (const row of rows) {
          await query(
            `INSERT INTO skill_feedback
              (skill_id, workspace_id, session_id, signal, evidence, claude_reflection, proposed_improvement, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [
              row.skill_id,
              row.workspace_id,
              row.session_id || null,
              row.signal,
              typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence),
              row.claude_reflection || null,
              row.proposed_improvement || null,
              row.created_at,
            ]
          );
        }

        // Mark as collected on client
        const ids = rows.map((r: any) => r.id);
        await runShell({
          command: `ssh -p ${sshPort} -o ConnectTimeout=10 ${sshTarget} "psql \\$DATABASE_URL -c \\"UPDATE skill_feedback SET collected = true WHERE id IN (${ids.join(",")})\\""`,
          timeoutMs: 15_000,
        });

        totalPulled += rows.length;

        // Check for skill improvement signals and trigger proposals
        const improvements = rows.filter((r: any) => r.signal === "skill_improvement");
        if (improvements.length > 0) {
          for (const imp of improvements) {
            await tasks.trigger("check-approvals", {
              type: "improvement",
              skillId: imp.skill_id,
              workspaceId: imp.workspace_id,
              reflection: imp.claude_reflection,
            });
          }
        }
      } catch (err) {
        logger.error(`Error scanning ${wsId}: ${err}`);
        errors.push(`${wsId}: ${String(err).slice(0, 100)}`);
      }
    }

    logger.info(`Scan complete: ${totalPulled} signals pulled, ${errors.length} errors`);
    return { totalPulled, errors, workspacesScanned: workspaceIds.length };
  },
});

// Run every 6 hours
export const scanWorkspacesSchedule = schedules.task({
  id: "scan-workspaces-schedule",
  cron: "0 */6 * * *",
  maxDuration: 60,
  run: async () => {
    await scanWorkspaces.trigger();
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add trigger/tasks/scan-workspaces.ts
git commit -m "feat: add scheduled SSH workspace scanner"
```

---

## Task 10: Create promotion pipeline (proposal-generator + dependency-checker + human-gate)

**Files:**
- Create: `orchestrator/promotion/proposal-generator.ts`
- Create: `orchestrator/promotion/dependency-checker.ts`
- Create: `orchestrator/promotion/human-gate.ts`

- [ ] **Step 1: Create directories**

```bash
mkdir -p orchestrator/promotion orchestrator/sync
```

- [ ] **Step 2: Create orchestrator/promotion/proposal-generator.ts**

```typescript
/**
 * Creates structured skill proposals from feedback signals.
 * Determines version bump (minor for improvements, patch for fixes).
 */

import { query } from "../db.js";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

interface SkillRegistryEntry {
  id: string;
  version: string;
  status: string;
  workspaces: string[];
}

function loadSkillVersion(skillId: string): string {
  try {
    const registryPath = join(NEXAAS_ROOT, "skills", "_registry.yaml");
    const raw = readFileSync(registryPath, "utf-8");
    const registry = yaml.load(raw) as { skills: SkillRegistryEntry[] };
    const skill = registry.skills.find((s) => s.id === skillId);
    return skill?.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function bumpVersion(version: string, type: "minor" | "patch"): string {
  const parts = version.split(".").map(Number);
  if (type === "minor") {
    parts[1] = (parts[1] || 0) + 1;
    parts[2] = 0;
  } else {
    parts[2] = (parts[2] || 0) + 1;
  }
  return parts.join(".");
}

export async function createProposal(params: {
  skillId: string;
  workspaceId: string;
  improvement: string;
  type: "improvement" | "fix";
  violations?: unknown[];
  pass1Clean?: boolean;
  pass2Clean?: boolean;
}): Promise<number> {
  const currentVersion = loadSkillVersion(params.skillId);
  const bumpType = params.type === "fix" ? "patch" : "minor";
  const proposedVersion = bumpVersion(currentVersion, bumpType);

  const result = await query(
    `INSERT INTO skill_proposals
      (skill_id, workspace_id, from_version, proposed_version,
       proposed_improvement, status, violations, pass1_clean, pass2_clean, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, NOW())
     RETURNING id`,
    [
      params.skillId,
      params.workspaceId,
      currentVersion,
      proposedVersion,
      params.improvement,
      params.violations ? JSON.stringify(params.violations) : null,
      params.pass1Clean ?? null,
      params.pass2Clean ?? null,
    ]
  );

  return result.rows[0].id as number;
}
```

- [ ] **Step 3: Create orchestrator/promotion/dependency-checker.ts**

```typescript
/**
 * Checks workspace compatibility for a skill update.
 * Ensures subscribed workspaces have required MCP servers and capabilities.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { loadManifest, type WorkspaceManifest } from "../bootstrap/manifest-loader.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export interface CompatibilityReport {
  skillId: string;
  proposedVersion: string;
  compatible: Array<{ workspaceId: string; name: string }>;
  incompatible: Array<{ workspaceId: string; name: string; missing: string[] }>;
}

interface SkillRequirements {
  mcp?: string[];
  capabilities?: Record<string, boolean>;
}

function loadSkillRequirements(skillId: string): SkillRequirements {
  try {
    const skillPath = join(NEXAAS_ROOT, "skills", ...skillId.split("/"), "skill.yaml");
    const raw = readFileSync(skillPath, "utf-8");
    const skill = yaml.load(raw) as any;
    return {
      mcp: skill?.resources?.mcp || [],
      capabilities: {},
    };
  } catch {
    return { mcp: [], capabilities: {} };
  }
}

function getSubscribedWorkspaceIds(skillId: string): string[] {
  try {
    const registryPath = join(NEXAAS_ROOT, "skills", "_registry.yaml");
    const raw = readFileSync(registryPath, "utf-8");
    const registry = yaml.load(raw) as { skills: Array<{ id: string; workspaces: string[] }> };
    const skill = registry.skills.find((s) => s.id === skillId);
    return skill?.workspaces || [];
  } catch {
    return [];
  }
}

export async function checkCompatibility(
  skillId: string,
  proposedVersion: string
): Promise<CompatibilityReport> {
  const requirements = loadSkillRequirements(skillId);
  const subscribedIds = getSubscribedWorkspaceIds(skillId);

  const compatible: CompatibilityReport["compatible"] = [];
  const incompatible: CompatibilityReport["incompatible"] = [];

  for (const wsId of subscribedIds) {
    try {
      const manifest = await loadManifest(wsId);
      const missing: string[] = [];

      // Check MCP servers
      const availableMcp = Object.keys(manifest.mcp);
      for (const required of requirements.mcp || []) {
        if (!availableMcp.includes(required)) {
          missing.push(`mcp:${required}`);
        }
      }

      // Check capabilities
      for (const [cap, needed] of Object.entries(requirements.capabilities || {})) {
        if (needed && !manifest.capabilities[cap]) {
          missing.push(`capability:${cap}`);
        }
      }

      if (missing.length === 0) {
        compatible.push({ workspaceId: wsId, name: manifest.name });
      } else {
        incompatible.push({ workspaceId: wsId, name: manifest.name, missing });
      }
    } catch {
      incompatible.push({ workspaceId: wsId, name: wsId, missing: ["manifest-not-found"] });
    }
  }

  return { skillId, proposedVersion, compatible, incompatible };
}
```

- [ ] **Step 4: Create orchestrator/promotion/human-gate.ts**

```typescript
/**
 * Human approval gate for skill proposals.
 *
 * Sends a Telegram notification with Approve/Reject buttons.
 * The Telegram bot callback writes approval to the DB.
 * A polling task picks up approved proposals and triggers sync.
 */

import { query, queryOne } from "../db.js";
import { notifyTelegram } from "../../trigger/lib/telegram.js";
import { checkCompatibility } from "./dependency-checker.js";

export async function sendApprovalRequest(proposalId: number): Promise<boolean> {
  const proposal = await queryOne(
    `SELECT * FROM skill_proposals WHERE id = $1`,
    [proposalId]
  );

  if (!proposal) return false;

  const skillId = proposal.skill_id as string;
  const fromVersion = proposal.from_version as string;
  const proposedVersion = proposal.proposed_version as string;
  const improvement = proposal.proposed_improvement as string;
  const workspaceId = proposal.workspace_id as string;

  // Check compatibility
  const compat = await checkCompatibility(skillId, proposedVersion);

  const compatText = compat.compatible.length > 0
    ? `Deploy to: ${compat.compatible.map((c) => c.name).join(", ")}`
    : "No compatible workspaces";

  const skipText = compat.incompatible.length > 0
    ? `\nSkip: ${compat.incompatible.map((c) => `${c.name} (${c.missing.join(", ")})`).join(", ")}`
    : "";

  await notifyTelegram({
    user: "al",
    type: "approval",
    title: `Skill Proposal: ${skillId} ${fromVersion} -> ${proposedVersion}`,
    body: `Source: ${workspaceId}\n\n${improvement.slice(0, 400)}\n\n${compatText}${skipText}`,
    buttons: [
      { text: "Approve", callback_data: `approve_proposal:${proposalId}` },
      { text: "Reject", callback_data: `reject_proposal:${proposalId}` },
    ],
    skipDedup: true,
  });

  return true;
}

export async function approveProposal(proposalId: number, reviewedBy: string): Promise<void> {
  await query(
    `UPDATE skill_proposals SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [proposalId, reviewedBy]
  );
}

export async function rejectProposal(proposalId: number, reviewedBy: string): Promise<void> {
  await query(
    `UPDATE skill_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [proposalId, reviewedBy]
  );
}

export async function expireStaleProposals(): Promise<number> {
  const result = await query(
    `UPDATE skill_proposals SET status = 'expired'
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}
```

- [ ] **Step 5: Commit**

```bash
git add orchestrator/promotion/
git commit -m "feat: add promotion pipeline (proposal-generator, dependency-checker, human-gate)"
```

---

## Task 11: Create sync layer (propagator + version-router)

**Files:**
- Create: `orchestrator/sync/propagator.ts`
- Create: `orchestrator/sync/version-router.ts`

- [ ] **Step 1: Create orchestrator/sync/version-router.ts**

```typescript
/**
 * Version pinning resolution.
 *
 * Checks if a workspace has a pinned version for a skill.
 * If pinned, returns that version. Otherwise returns "latest".
 */

import { queryOne } from "../db.js";

export async function resolveVersion(
  workspaceId: string,
  skillId: string,
  latestVersion: string
): Promise<string> {
  const pin = await queryOne(
    `SELECT pinned_version FROM workspace_skills
     WHERE workspace_id = $1 AND skill_id = $2 AND active = true`,
    [workspaceId, skillId]
  );

  if (pin?.pinned_version) {
    return pin.pinned_version as string;
  }

  return latestVersion;
}
```

- [ ] **Step 2: Create orchestrator/sync/propagator.ts**

```typescript
/**
 * Pushes approved skill updates to subscribed workspaces via SSH + rsync.
 */

import { logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../../trigger/lib/shell.js";
import { query } from "../db.js";
import { loadManifest } from "../bootstrap/manifest-loader.js";
import { checkCompatibility } from "../promotion/dependency-checker.js";
import { resolveVersion } from "./version-router.js";
import { join } from "path";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export interface SyncResult {
  skillId: string;
  version: string;
  synced: string[];
  skipped: string[];
  failed: Array<{ workspaceId: string; error: string }>;
}

export async function propagateSkill(
  skillId: string,
  proposedVersion: string
): Promise<SyncResult> {
  const compat = await checkCompatibility(skillId, proposedVersion);
  const skillDir = join(NEXAAS_ROOT, "skills", ...skillId.split("/"));

  const synced: string[] = [];
  const failed: SyncResult["failed"] = [];

  for (const ws of compat.compatible) {
    try {
      const manifest = await loadManifest(ws.workspaceId);
      if (!manifest.ssh) {
        failed.push({ workspaceId: ws.workspaceId, error: "no SSH config" });
        continue;
      }

      const version = await resolveVersion(ws.workspaceId, skillId, proposedVersion);
      if (version !== proposedVersion) {
        logger.info(`${ws.workspaceId} pinned to v${version}, skipping v${proposedVersion}`);
        continue;
      }

      const { host, user, port } = manifest.ssh;
      const sshPort = port || 22;
      const destPath = `/opt/nexaas/skills/${skillId.replace("/", "/")}`;

      // Rsync skill directory to client
      const rsyncResult = await runShell({
        command: `rsync -av --delete -e "ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" "${skillDir}/" "${user}@${host}:${destPath}/"`,
        timeoutMs: 60_000,
      });

      if (!rsyncResult.success) {
        failed.push({ workspaceId: ws.workspaceId, error: rsyncResult.stderr.slice(0, 200) });
        continue;
      }

      // Record version on core
      await query(
        `INSERT INTO skill_versions (skill_id, version, status, manifest, promoted_at)
         VALUES ($1, $2, 'stable', $3, NOW())
         ON CONFLICT (skill_id, version) DO NOTHING`,
        [skillId, proposedVersion, JSON.stringify({ workspaceId: ws.workspaceId })]
      );

      synced.push(ws.workspaceId);
      logger.info(`Synced ${skillId} v${proposedVersion} to ${ws.workspaceId}`);
    } catch (err) {
      failed.push({ workspaceId: ws.workspaceId, error: String(err).slice(0, 200) });
    }
  }

  return {
    skillId,
    version: proposedVersion,
    synced,
    skipped: compat.incompatible.map((w) => w.workspaceId),
    failed,
  };
}

/**
 * Git commit and push the updated skill after promotion.
 */
export async function commitSkillUpdate(
  skillId: string,
  version: string
): Promise<boolean> {
  const result = await runShell({
    command: `cd "${NEXAAS_ROOT}" && git add skills/ && git diff --cached --quiet || git commit -m "promote: ${skillId} v${version}"`,
    cwd: NEXAAS_ROOT,
    timeoutMs: 30_000,
  });

  if (result.success) {
    const pushResult = await runShell({
      command: `cd "${NEXAAS_ROOT}" && git push`,
      cwd: NEXAAS_ROOT,
      timeoutMs: 30_000,
    });
    return pushResult.success;
  }

  return false;
}
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/sync/
git commit -m "feat: add sync layer (propagator + version-router)"
```

---

## Task 12: Fill sync-skills stub and create check-approvals task

**Files:**
- Modify: `trigger/tasks/sync-skills.ts`
- Create: `trigger/tasks/check-approvals.ts`

- [ ] **Step 1: Fill trigger/tasks/sync-skills.ts**

Replace the entire file:

```typescript
/**
 * Skill sync task — orchestrates the full promotion flow.
 *
 * Called by check-approvals when a proposal is approved.
 * Runs: propagator → version-router → rsync → git commit.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { propagateSkill, commitSkillUpdate } from "../../orchestrator/sync/propagator.js";
import { notifyTelegram } from "../lib/telegram.js";
import { query } from "../../orchestrator/db.js";

export const syncSkills = task({
  id: "sync-skills",
  queue: { name: "skill-sync", concurrencyLimit: 1 },
  maxDuration: 600, // 10 min — rsync to multiple VPSes
  run: async (payload: { proposalId: number; skillId: string; version: string }) => {
    logger.info(`Syncing skill: ${payload.skillId} v${payload.version}`);

    const result = await propagateSkill(payload.skillId, payload.version);

    // Git commit + push
    if (result.synced.length > 0) {
      await commitSkillUpdate(payload.skillId, payload.version);
    }

    // Update proposal status
    await query(
      `UPDATE skill_proposals SET status = 'deployed' WHERE id = $1`,
      [payload.proposalId]
    );

    // Telegram confirmation
    await notifyTelegram({
      user: "al",
      type: "briefing",
      title: `Synced: ${payload.skillId} v${payload.version}`,
      body: `Deployed to: ${result.synced.join(", ") || "none"}\nSkipped: ${result.skipped.join(", ") || "none"}\nFailed: ${result.failed.map((f) => f.workspaceId).join(", ") || "none"}`,
    });

    return result;
  },
});
```

- [ ] **Step 2: Create trigger/tasks/check-approvals.ts**

```typescript
/**
 * Polls for approved skill proposals and triggers sync.
 * Runs every 5 minutes on the core.
 * Also expires stale proposals (>7 days pending).
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { query } from "../../orchestrator/db.js";
import { expireStaleProposals } from "../../orchestrator/promotion/human-gate.js";
import { syncSkills } from "./sync-skills.js";

export const checkApprovals = task({
  id: "check-approvals",
  queue: { name: "orchestrator", concurrencyLimit: 1 },
  maxDuration: 120,
  run: async () => {
    // Expire stale proposals first
    const expired = await expireStaleProposals();
    if (expired > 0) {
      logger.info(`Expired ${expired} stale proposals`);
    }

    // Find approved proposals not yet deployed
    const approved = await query(
      `SELECT id, skill_id, proposed_version FROM skill_proposals
       WHERE status = 'approved'
       ORDER BY reviewed_at ASC LIMIT 5`
    );

    if (approved.rows.length === 0) {
      return { checked: true, deployments: 0 };
    }

    logger.info(`Found ${approved.rows.length} approved proposals to deploy`);

    for (const proposal of approved.rows) {
      await syncSkills.triggerAndWait({
        proposalId: proposal.id as number,
        skillId: proposal.skill_id as string,
        version: proposal.proposed_version as string,
      });
    }

    return { checked: true, deployments: approved.rows.length };
  },
});

// Run every 5 minutes
export const checkApprovalsSchedule = schedules.task({
  id: "check-approvals-schedule",
  cron: "*/5 * * * *",
  maxDuration: 30,
  run: async () => {
    await checkApprovals.trigger();
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add trigger/tasks/sync-skills.ts trigger/tasks/check-approvals.ts
git commit -m "feat: add approval polling and fill sync-skills task"
```

---

## Task 13: Implement context store

**Files:**
- Modify: `orchestrator/context/store.ts`
- Create: `orchestrator/context/thread-resolver.ts`

- [ ] **Step 1: Implement orchestrator/context/store.ts**

Replace the entire stub:

```typescript
/**
 * Conversation context store.
 *
 * Persists conversation state across task invocations using thread IDs.
 * TTL cascades: skill override → workspace override → global default (90 days).
 */

import { query, queryOne } from "../db.js";
import { runClaude } from "../../trigger/lib/claude.js";

export interface ConversationContext {
  threadId: string;
  workspaceId: string;
  skillId?: string;
  turns: Array<{ role: string; content: string; timestamp: string }>;
  summary?: string;
  status: string;
}

const DEFAULT_TTL_DAYS = 90;
const DEFAULT_MAX_TURNS = 10;
const TURNS_KEPT_FULL = 5;

export function resolveTtl(
  skillContext?: { threadTtlDays?: number },
  workspaceContext?: { threadTtlDays?: number }
): number {
  return skillContext?.threadTtlDays
    ?? workspaceContext?.threadTtlDays
    ?? DEFAULT_TTL_DAYS;
}

export function resolveMaxTurns(
  skillContext?: { maxTurnsBeforeSummary?: number },
  workspaceContext?: { maxTurnsBeforeSummary?: number }
): number {
  return skillContext?.maxTurnsBeforeSummary
    ?? workspaceContext?.maxTurnsBeforeSummary
    ?? DEFAULT_MAX_TURNS;
}

export async function loadConversationContext(
  threadId: string
): Promise<ConversationContext | null> {
  const row = await queryOne(
    `SELECT thread_id, workspace_id, skill_id, turns, summary, status
     FROM conversation_contexts
     WHERE thread_id = $1 AND status = 'active'`,
    [threadId]
  );

  if (!row) return null;

  return {
    threadId: row.thread_id as string,
    workspaceId: row.workspace_id as string,
    skillId: row.skill_id as string | undefined,
    turns: typeof row.turns === "string" ? JSON.parse(row.turns as string) : (row.turns as any),
    summary: row.summary as string | undefined,
    status: row.status as string,
  };
}

export async function saveConversationContext(
  threadId: string,
  context: {
    workspaceId: string;
    skillId?: string;
    turns: Array<{ role: string; content: string; timestamp: string }>;
    summary?: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO conversation_contexts (thread_id, workspace_id, skill_id, turns, summary, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (thread_id) DO UPDATE SET
       turns = $4,
       summary = $5,
       updated_at = NOW()`,
    [
      threadId,
      context.workspaceId,
      context.skillId || null,
      JSON.stringify(context.turns),
      context.summary || null,
    ]
  );
}

/**
 * Summarize old turns and keep only the last N full turns.
 */
export async function windowContext(
  context: ConversationContext,
  maxTurns: number
): Promise<ConversationContext> {
  if (context.turns.length <= maxTurns) return context;

  const oldTurns = context.turns.slice(0, context.turns.length - TURNS_KEPT_FULL);
  const recentTurns = context.turns.slice(-TURNS_KEPT_FULL);

  // Summarize old turns via Claude Haiku
  const oldText = oldTurns
    .map((t) => `${t.role}: ${t.content.slice(0, 500)}`)
    .join("\n");

  const existingSummary = context.summary ? `Previous summary: ${context.summary}\n\n` : "";

  const result = await runClaude({
    prompt: `Summarize this conversation history in 2-3 sentences. Focus on key decisions, outcomes, and pending items.\n\n${existingSummary}New turns:\n${oldText}`,
    model: "haiku",
    timeoutMs: 30_000,
    mcpServers: [],
  });

  const summary = result.success ? result.output.slice(0, 1000) : context.summary || "";

  return {
    ...context,
    turns: recentTurns,
    summary,
  };
}

/**
 * Clean up expired contexts. Run daily on each client.
 */
export async function cleanupExpiredContexts(ttlDays: number = DEFAULT_TTL_DAYS): Promise<number> {
  const result = await query(
    `DELETE FROM conversation_contexts
     WHERE updated_at < NOW() - ($1 || ' days')::INTERVAL
     RETURNING thread_id`,
    [ttlDays]
  );
  return result.rowCount ?? 0;
}
```

- [ ] **Step 2: Create orchestrator/context/thread-resolver.ts**

```typescript
/**
 * Extracts thread ID from different source types.
 */

export function resolveThreadId(
  source: string,
  sourceData?: Record<string, unknown>
): string | undefined {
  if (!sourceData) return undefined;

  switch (source) {
    case "email":
      return (sourceData.messageId as string) || (sourceData.threadId as string);
    case "webhook":
      return (sourceData.correlationId as string) || (sourceData.requestId as string);
    case "manual":
      return sourceData.threadId as string;
    case "schedule":
      return undefined; // Scheduled tasks don't have threads
    default:
      return undefined;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/context/
git commit -m "feat: implement context store with windowed summarization"
```

---

## Task 14: Add database migration for collected column

**Files:**
- Create: `database/migrations/004_feedback_collected.sql`

- [ ] **Step 1: Create migration**

```sql
-- Add collected column to skill_feedback for SSH sweep tracking
ALTER TABLE skill_feedback ADD COLUMN IF NOT EXISTS collected BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_skill_feedback_collected ON skill_feedback(collected) WHERE collected = false;
```

- [ ] **Step 2: Update database/schema.sql**

Add `collected BOOLEAN DEFAULT FALSE` to the `skill_feedback` table definition, after the `proposed_improvement` column.

- [ ] **Step 3: Commit**

```bash
git add database/
git commit -m "chore: add collected column to skill_feedback"
```

---

## Task 15: Update schedules index and verify TypeScript compiles

**Files:**
- Modify: `trigger/schedules/index.ts`

- [ ] **Step 1: Update trigger/schedules/index.ts**

Replace with:

```typescript
/**
 * Cron schedule definitions.
 * Re-exports all scheduled tasks so Trigger.dev discovers them.
 */

// Skill runner schedules (batch dispatch)
export { dispatchFrequent, scheduledCheck } from "../tasks/run-skill.js";

// Core orchestration schedules
export { scanWorkspacesSchedule } from "../tasks/scan-workspaces.js";
export { checkApprovalsSchedule } from "../tasks/check-approvals.js";
```

- [ ] **Step 2: Run TypeScript compilation**

```bash
npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 3: Commit**

```bash
git add trigger/schedules/index.ts
git commit -m "feat: wire Phase 2 schedules and verify compilation"
```

---

## Task 16: Final verification

- [ ] **Step 1: Verify all new files exist**

```bash
ls orchestrator/db.ts \
   orchestrator/feedback/collector.ts \
   orchestrator/feedback/sanitizer.ts \
   orchestrator/feedback/escalation.ts \
   orchestrator/context/store.ts \
   orchestrator/context/thread-resolver.ts \
   orchestrator/promotion/proposal-generator.ts \
   orchestrator/promotion/dependency-checker.ts \
   orchestrator/promotion/human-gate.ts \
   orchestrator/sync/propagator.ts \
   orchestrator/sync/version-router.ts \
   trigger/tasks/receive-escalation.ts \
   trigger/tasks/diagnose-failure.ts \
   trigger/tasks/scan-workspaces.ts \
   trigger/tasks/check-approvals.ts
```

- [ ] **Step 2: Verify TypeScript compiles clean**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Review commit history**

```bash
git log --oneline -20
```

Expected: ~15 commits for Phase 2 on top of Phase 1.
