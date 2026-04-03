# Nexaas v2 Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Nexaas repo into the v2 directory layout with Phoenix VPS's battle-tested Trigger.dev code as the execution engine, multi-workspace bootstrap layer, and all framework assets moved to their new homes.

**Architecture:** Scaffold directory structure + Phoenix Trigger.dev code generalized for multi-workspace. Claude Code CLI subprocess pattern (not Agent SDK). Thin orchestrator/bootstrap layer resolves workspace context before passing to runClaude().

**Tech Stack:** TypeScript, Trigger.dev v4, Node.js 20+, npm, Postgres 16, Claude Code CLI, Zod

**Spec:** `docs/superpowers/specs/2026-04-03-nexaas-v2-refactor-design.md`

---

## File Map

### New files to create

| File | Responsibility |
|---|---|
| `package.json` | Root monorepo package (Trigger.dev + orchestrator deps) |
| `tsconfig.json` | Root TS config (trigger/, orchestrator/) |
| `.triggerignore` | Prevent file-watcher rebuild loops |
| `.env.example` | All env vars documented |
| `trigger/trigger.config.ts` | Trigger.dev config with onFailure self-healing |
| `trigger/tasks/run-agent.ts` | Generic Claude CLI runner task |
| `trigger/tasks/run-skill.ts` | Skill runner with batch dispatch |
| `trigger/tasks/sync-skills.ts` | Phase 2 stub |
| `trigger/tasks/cron-tasks.ts` | Shell-based cron tasks |
| `trigger/schedules/index.ts` | Cron schedule definitions |
| `trigger/lib/claude.ts` | Claude Code CLI wrapper (from Phoenix, generalized) |
| `trigger/lib/shell.ts` | Shell runner (from Phoenix, generalized) |
| `trigger/lib/telegram.ts` | Telegram notifications (from Phoenix) |
| `trigger/lib/domain-tags.ts` | Business domain tagging (from Phoenix, generalized) |
| `trigger/lib/yaml-checks.ts` | YAML check loader (from Phoenix, generalized) |
| `trigger/lib/yaml-lite.ts` | Minimal YAML parser (from Phoenix) |
| `trigger/scripts/sync-schedules.ts` | Schedule sync tool (from Phoenix) |
| `orchestrator/bootstrap/index.ts` | createWorkspaceSession() |
| `orchestrator/bootstrap/manifest-loader.ts` | Reads workspace manifests |
| `orchestrator/bootstrap/mcp-injector.ts` | Resolves MCP servers for session |
| `orchestrator/context/store.ts` | Stub for Phase 2 |
| `mcp/_registry.yaml` | MCP server registry |
| `skills/_registry.yaml` | Master skill index |
| `skills/README.md` | Skill authoring guide |
| `workspaces/_template.workspace.json` | Blank workspace template |
| `workspaces/nexaas-core.workspace.json` | Nexaas own workspace |
| `workspaces/phoenix-voyages.workspace.json` | Phoenix Voyages workspace |
| `platform/docker-compose.yml` | Trigger.dev + Postgres + Redis + MinIO |
| `platform/.env.example` | Platform env vars |
| `database/schema.sql` | Unified Postgres schema |
| `templates/skill.yaml` | Skill manifest template |
| `templates/prompt.md` | Skill prompt template |
| `templates/workspace.workspace.json` | Workspace manifest template |
| `scripts/provision-workspace.sh` | Client VPS provisioning |
| `scripts/start-worker.sh` | Memory-safe worker launcher |
| `scripts/trigger-dev-worker.service` | Systemd unit template |

### Files moved via git mv

| From | To |
|---|---|
| `framework/mcp-servers/*.yaml` (16) | `mcp/configs/*.yaml` |
| `framework/agents/ops-monitor/` | `agents/ops-monitor/` |
| `framework/skills/contribute.md` | `skills/contribute.md` |
| `framework/skills/health-check.md` | `skills/health-check.md` |
| `docker-compose.yml` | `platform/docker-compose.old.yml` |

### Files replaced

| File | Source |
|---|---|
| `CLAUDE.md` | Scaffold zip CLAUDE.md |

### Files untouched

- `dashboard/` (entire directory)
- `engine/` (entire directory)
- `CLAUDE.ops.md`
- `examples/`
- `scripts/health-check.sh`
- `scripts/update.sh`
- `scripts/update-all.sh`
- `scripts/contribute.sh`

---

## Task 1: Create v2-foundation branch and root config files

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.triggerignore`
- Create: `.env.example`

- [ ] **Step 1: Create branch**

```bash
git checkout -b v2-foundation
```

- [ ] **Step 2: Create root package.json**

Create `package.json`:

```json
{
  "name": "nexaas",
  "version": "2.0.0",
  "private": true,
  "description": "Nexaas — AI business automation backbone for Nexmatic",
  "type": "module",
  "scripts": {
    "dev": "npx trigger.dev@latest dev",
    "deploy": "npx trigger.dev@latest deploy"
  },
  "dependencies": {
    "@trigger.dev/sdk": "^4.4.2",
    "better-sqlite3": "^11.0.0",
    "js-yaml": "^4.1.1",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.0.0",
    "trigger.dev": "^4.4.3",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "paths": {
      "@nexaas/*": ["./*"]
    }
  },
  "include": ["trigger/**/*.ts", "orchestrator/**/*.ts"],
  "exclude": ["node_modules", "dist", "dashboard", "engine"]
}
```

- [ ] **Step 4: Create .triggerignore**

Create `.triggerignore`:

```
node_modules
.trigger
scripts
*.md
*.json
*.env*
.git
dashboard
engine
framework
docs
```

- [ ] **Step 5: Create .env.example**

Create `.env.example`:

```bash
# Trigger.dev
TRIGGER_SECRET_KEY=              # generate: openssl rand -hex 32
TRIGGER_API_URL=                 # self-hosted: http://localhost:3040
TRIGGER_PROJECT_REF=             # from Trigger.dev dashboard

# Database (shared Postgres)
DATABASE_URL=postgresql://trigger:PASSWORD@localhost:5432/nexaas

# MinIO (artifact storage)
MINIO_USER=nexaas
MINIO_PASSWORD=                  # strong password
MINIO_ENDPOINT=http://localhost:9000

# Anthropic
ANTHROPIC_API_KEY=               # your key

# Nexaas
NEXAAS_ROOT=/opt/nexaas
NEXAAS_WORKSPACE=                # workspace ID for this Trigger project
WORKSPACE_ROOT=                  # absolute path to workspace on VPS

# Claude Code
CLAUDE_CODE_PATH=claude          # path to claude CLI binary

# Notifications
TELEGRAM_BRIDGE_URL=http://127.0.0.1:8420
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .triggerignore .env.example
git commit -m "chore: add root TypeScript + Trigger.dev config for v2"
```

---

## Task 2: Move framework assets to new locations

**Files:**
- Move: `framework/mcp-servers/*.yaml` → `mcp/configs/*.yaml`
- Move: `framework/agents/ops-monitor/` → `agents/ops-monitor/`
- Move: `framework/skills/*.md` → `skills/`
- Move: `docker-compose.yml` → `platform/docker-compose.old.yml`

- [ ] **Step 1: Create target directories**

```bash
mkdir -p mcp/configs
mkdir -p agents
mkdir -p skills
mkdir -p platform
```

- [ ] **Step 2: Move MCP configs (16 files)**

```bash
git mv framework/mcp-servers/brave-search.yaml mcp/configs/brave-search.yaml
git mv framework/mcp-servers/docuseal.yaml mcp/configs/docuseal.yaml
git mv framework/mcp-servers/email.yaml mcp/configs/email.yaml
git mv framework/mcp-servers/fetch.yaml mcp/configs/fetch.yaml
git mv framework/mcp-servers/filesystem.yaml mcp/configs/filesystem.yaml
git mv framework/mcp-servers/github.yaml mcp/configs/github.yaml
git mv framework/mcp-servers/groundhogg.yaml mcp/configs/groundhogg.yaml
git mv framework/mcp-servers/m365.yaml mcp/configs/m365.yaml
git mv framework/mcp-servers/memory.yaml mcp/configs/memory.yaml
git mv framework/mcp-servers/nextcloud.yaml mcp/configs/nextcloud.yaml
git mv framework/mcp-servers/playwright.yaml mcp/configs/playwright.yaml
git mv framework/mcp-servers/postgres.yaml mcp/configs/postgres.yaml
git mv framework/mcp-servers/sequential-thinking.yaml mcp/configs/sequential-thinking.yaml
git mv framework/mcp-servers/slack.yaml mcp/configs/slack.yaml
git mv framework/mcp-servers/telegram.yaml mcp/configs/telegram.yaml
git mv framework/mcp-servers/vaultwarden.yaml mcp/configs/vaultwarden.yaml
```

- [ ] **Step 3: Move agents**

```bash
git mv framework/agents/ops-monitor agents/ops-monitor
```

- [ ] **Step 4: Move skills**

```bash
git mv framework/skills/contribute.md skills/contribute.md
git mv framework/skills/health-check.md skills/health-check.md
```

- [ ] **Step 5: Move docker-compose for reference**

```bash
git mv docker-compose.yml platform/docker-compose.old.yml
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move framework/ assets to mcp/, agents/, skills/"
```

---

## Task 3: Create MCP registry and skill registry

**Files:**
- Create: `mcp/_registry.yaml`
- Create: `skills/_registry.yaml`
- Create: `skills/README.md`

- [ ] **Step 1: Create MCP registry**

Create `mcp/_registry.yaml` — copy from scaffold zip (already read, content in spec conversation). This is the file from `/tmp/nexaas-scaffold/_registry.yaml` containing all 16 servers with ports, capabilities, and required env vars.

- [ ] **Step 2: Create skill registry**

Create `skills/_registry.yaml`:

```yaml
# skills/_registry.yaml
# Master skill index — source of truth for all skills in the network
version: "2.0"

skills:
  - id: msp/email-triage
    version: "1.0.0"
    status: planned
    description: "Triage and route inbound MSP client emails"
    dependencies: []
    mcp: [email, filesystem]
    model: claude-haiku-4-5
    claudeMd: minimal
    maxTurns: 10
    workspaces: []

  - id: msp/health-check
    version: "1.0.0"
    status: planned
    description: "Run infrastructure health checks across client environments"
    dependencies: []
    mcp: [filesystem, postgres]
    model: claude-haiku-4-5
    claudeMd: minimal
    maxTurns: 15
    workspaces: []

  - id: finance/receipt-scanner
    version: "1.0.0"
    status: planned
    description: "Extract and categorize expense data from receipt images"
    dependencies: []
    mcp: [filesystem]
    model: claude-haiku-4-5
    claudeMd: minimal
    maxTurns: 5
    workspaces: []
```

- [ ] **Step 3: Create skills README**

Create `skills/README.md`:

```markdown
# Nexaas Skill Registry

Skills are reusable AI capabilities that run across workspaces.

## Structure

Each skill lives in `skills/[category]/[skill-name]/` and contains:
- `skill.yaml` — manifest (id, version, resources, inputs, outputs)
- `prompt.md` — Claude instructions
- `task.ts` — Trigger.dev task wrapper (optional)
- `tests/` — test cases

## Self-Reflection Protocol

Every skill prompt MUST end with the self-reflection marker:

```
SKILL_IMPROVEMENT_CANDIDATE: [generic capability description, no client data]
```

See `templates/prompt.md` for the full template.
```

- [ ] **Step 4: Commit**

```bash
git add mcp/_registry.yaml skills/_registry.yaml skills/README.md
git commit -m "feat: add MCP and skill registries"
```

---

## Task 4: Create templates from scaffold

**Files:**
- Create: `templates/skill.yaml`
- Create: `templates/prompt.md`
- Create: `templates/workspace.workspace.json`

- [ ] **Step 1: Create skill.yaml template**

Create `templates/skill.yaml` — copy from scaffold zip (`/tmp/nexaas-scaffold/skill.yaml`). Contains the full skill manifest template with id, version, resources, inputs, outputs, tests, and changelog fields.

- [ ] **Step 2: Create prompt.md template**

Create `templates/prompt.md` — copy from scaffold zip (`/tmp/nexaas-scaffold/prompt.md`). Contains the skill prompt template with Purpose, Context, Instructions, Output Format, Error Handling, and Self-Reflection Protocol sections.

- [ ] **Step 3: Create workspace manifest template**

Create `templates/workspace.workspace.json` — copy from scaffold zip (`/tmp/nexaas-scaffold/workspace.workspace.json`). Contains the blank workspace manifest with id, name, workspaceRoot, claudeMd, skills, agents, mcp, capabilities, trigger, and context fields.

- [ ] **Step 4: Commit**

```bash
git add templates/skill.yaml templates/prompt.md templates/workspace.workspace.json
git commit -m "feat: add skill, prompt, and workspace templates"
```

---

## Task 5: Create workspace manifests

**Files:**
- Create: `workspaces/_template.workspace.json`
- Create: `workspaces/nexaas-core.workspace.json`
- Create: `workspaces/phoenix-voyages.workspace.json`

- [ ] **Step 1: Create directory and template**

```bash
mkdir -p workspaces
```

Create `workspaces/_template.workspace.json` — same content as `templates/workspace.workspace.json`.

- [ ] **Step 2: Create nexaas-core workspace**

Create `workspaces/nexaas-core.workspace.json`:

```json
{
  "id": "nexaas-core",
  "name": "Nexaas Core",
  "workspaceRoot": "/opt/nexaas",
  "claudeMd": {
    "full": "/opt/nexaas/CLAUDE.md",
    "summary": "/opt/nexaas/CLAUDE.md",
    "minimal": "/opt/nexaas/CLAUDE.md"
  },
  "skills": [],
  "agents": ["ops-monitor"],
  "mcp": {
    "filesystem": "http://localhost:3100",
    "github": "http://localhost:3103"
  },
  "capabilities": {
    "playwright": false,
    "docker": true,
    "bash": true
  },
  "trigger": {
    "projectId": "proj_nexaas_core",
    "workerUrl": "http://localhost:3000"
  },
  "context": {
    "threadTtlDays": 90,
    "maxTurnsBeforeSummary": 10
  }
}
```

- [ ] **Step 3: Create phoenix-voyages workspace**

Create `workspaces/phoenix-voyages.workspace.json`:

```json
{
  "id": "phoenix-voyages",
  "name": "Phoenix Voyages",
  "workspaceRoot": "/home/ubuntu/Phoenix-Voyages",
  "claudeMd": {
    "full": "/home/ubuntu/Phoenix-Voyages/CLAUDE.md",
    "summary": "/home/ubuntu/Phoenix-Voyages/CLAUDE.md",
    "minimal": "/home/ubuntu/Phoenix-Voyages/CLAUDE.md"
  },
  "skills": [
    "msp/health-check",
    "finance/receipt-scanner"
  ],
  "agents": [
    "pa",
    "crm",
    "marketing",
    "operations",
    "social-inbox",
    "accounting",
    "hr",
    "seo"
  ],
  "mcp": {
    "filesystem": "http://localhost:3100",
    "email": "http://localhost:3101",
    "groundhogg": "http://localhost:3102",
    "github": "http://localhost:3103",
    "nextcloud": "http://localhost:3104",
    "playwright": "http://localhost:3105"
  },
  "capabilities": {
    "playwright": true,
    "docker": true,
    "bash": true
  },
  "trigger": {
    "projectId": "proj_phoenix_local",
    "workerUrl": "http://localhost:3000"
  },
  "domainMap": {
    "crm": "crm",
    "hr": "hr",
    "marketing": "marketing",
    "pa": "pa",
    "pa/al": "pa",
    "pa/mireille": "pa",
    "pa/seb": "pa",
    "seo": "seo",
    "social-inbox": "social",
    "operations": "operations",
    "accounting": "accounting"
  },
  "context": {
    "threadTtlDays": 90,
    "maxTurnsBeforeSummary": 10
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add workspaces/
git commit -m "feat: add workspace manifests for nexaas-core and phoenix-voyages"
```

---

## Task 6: Pull Phoenix trigger libs (generalized)

**Files:**
- Create: `trigger/lib/claude.ts`
- Create: `trigger/lib/shell.ts`
- Create: `trigger/lib/telegram.ts`
- Create: `trigger/lib/yaml-lite.ts`

These four files are pulled from the Phoenix VPS and generalized.

- [ ] **Step 1: Create directory**

```bash
mkdir -p trigger/lib
```

- [ ] **Step 2: Create trigger/lib/claude.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/claude.ts"`

Apply three generalizations:
1. Change `WORKSPACE_ROOT` constant to default from `process.env.WORKSPACE_ROOT || process.env.NEXAAS_ROOT || "/opt/nexaas"`.
2. Add `workspaceRoot?: string` to `ClaudeOptions` interface. In `runClaude()`, use `options.workspaceRoot || WORKSPACE_ROOT` for cwd default and agent prompt resolution.
3. Change `loadProjectMcpConfig()` to accept optional `mcpConfigPath?: string` parameter. Default: `join(workspaceRoot, ".mcp.json")`.

Do NOT change any stability code: `detached: true`, process group kill, SIGTERM/SIGKILL escalation, `--strict-mcp-config`, stream-json parsing, `CLAUDECODE` env cleanup.

- [ ] **Step 3: Create trigger/lib/shell.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/shell.ts"`

One generalization: change `WORKSPACE_ROOT` constant to default from `process.env.WORKSPACE_ROOT || process.env.NEXAAS_ROOT || "/opt/nexaas"`.

Do NOT change process group cleanup, timeout escalation, or logger streaming.

- [ ] **Step 4: Create trigger/lib/telegram.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/telegram.ts"`

No changes needed — already reads from `process.env.TELEGRAM_BRIDGE_URL`.

- [ ] **Step 5: Create trigger/lib/yaml-lite.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/yaml-lite.ts"`

No changes needed.

- [ ] **Step 6: Commit**

```bash
git add trigger/lib/claude.ts trigger/lib/shell.ts trigger/lib/telegram.ts trigger/lib/yaml-lite.ts
git commit -m "feat: add trigger libs from Phoenix (claude, shell, telegram, yaml-lite)"
```

---

## Task 7: Pull Phoenix trigger libs (domain-tags, yaml-checks)

**Files:**
- Create: `trigger/lib/domain-tags.ts`
- Create: `trigger/lib/yaml-checks.ts`

- [ ] **Step 1: Create trigger/lib/domain-tags.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/domain-tags.ts"`

Generalize:
1. Remove the hardcoded `AGENT_DOMAIN_MAP` and `domainForAgent()` implementation.
2. Replace with manifest-driven approach:

```typescript
import { readFileSync } from "fs";
import { join } from "path";

export type Domain =
  | "accounting"
  | "crm"
  | "hr"
  | "marketing"
  | "operations"
  | "pa"
  | "seo"
  | "social"
  | "data-sync";

export function domainTag(domain: Domain): string[] {
  return [`domain:${domain}`];
}

/**
 * Resolve domain from agent name using a workspace domain map.
 * The map is loaded from workspace manifest's `domainMap` field.
 * Falls back to "operations" if no match.
 */
export function domainForAgent(
  agent: string,
  domainMap?: Record<string, Domain>
): Domain {
  if (!domainMap) return "operations";
  // Exact match first
  if (domainMap[agent]) return domainMap[agent];
  // Prefix match
  const prefix = Object.keys(domainMap).find((k) => agent.startsWith(k));
  return prefix ? domainMap[prefix] : "operations";
}
```

- [ ] **Step 2: Create trigger/lib/yaml-checks.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/lib/yaml-checks.ts"`

Generalize:
1. Change `CHECKS_DIR` constant to be derived from `process.env.WORKSPACE_ROOT`: `join(process.env.WORKSPACE_ROOT || "/opt/nexaas", "operations", "memory", "checks")`.
2. Add optional `checksDir` parameter to `loadAllChecks(checksDir?)`, `loadActiveChecks(checksDir?)`, `loadCheckById(id, checksDir?)`, and `getDueChecks(now, recurrenceFilter?, checksDir?)`.

All cron conversion logic (`checkToCron`), due-check bucketing, and prompt building (`buildCheckPrompt`) stay exactly as-is.

- [ ] **Step 3: Commit**

```bash
git add trigger/lib/domain-tags.ts trigger/lib/yaml-checks.ts
git commit -m "feat: add trigger libs from Phoenix (domain-tags, yaml-checks)"
```

---

## Task 8: Pull Phoenix trigger tasks

**Files:**
- Create: `trigger/trigger.config.ts`
- Create: `trigger/tasks/run-agent.ts`
- Create: `trigger/tasks/run-skill.ts`
- Create: `trigger/tasks/cron-tasks.ts`
- Create: `trigger/tasks/sync-skills.ts`
- Create: `trigger/schedules/index.ts`
- Create: `trigger/scripts/sync-schedules.ts`

- [ ] **Step 1: Create directories**

```bash
mkdir -p trigger/tasks trigger/schedules trigger/scripts
```

- [ ] **Step 2: Create trigger/trigger.config.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/trigger.config.ts"`

Generalize:
1. Change `project` to `process.env.TRIGGER_PROJECT_REF!` (already is in Phoenix but uses literal string).
2. Change `dirs` from `["src/trigger"]` to `["tasks", "schedules"]`.
3. Extract the onFailure skip list to a const:

```typescript
const SKIP_SELF_HEAL = [
  "self-heal",          // avoid loops
  "sync-skills",        // Phase 2
];
```

Keep `onFailure` logic pattern (skip check, then trigger self-heal task), but use the array:

```typescript
onFailure: async ({ payload, error, ctx }) => {
  const taskId = ctx.task.id;
  if (SKIP_SELF_HEAL.some(s => taskId.includes(s))) return;
  await tasks.trigger("self-heal", {
    taskId,
    error: error instanceof Error ? error.message : String(error),
    runId: ctx.run.id,
  });
},
```

- [ ] **Step 3: Create trigger/tasks/run-agent.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/trigger/run-agent.ts"`

One change: update import path from `"../lib/claude.js"` to `"../lib/claude.js"` (same relative path from tasks/ to lib/ as Phoenix's trigger/ to lib/).

No other changes — this file is already generic.

- [ ] **Step 4: Create trigger/tasks/run-skill.ts**

Based on Phoenix's `scheduled-check.ts`, generalized:
1. Remove Phoenix-specific `AGENT_MCP_MAP` — use `createWorkspaceSession()` for MCP resolution instead.
2. Keep the batch dispatch pattern (`dispatchDueChecks`, `dispatchFrequent`).
3. Keep `runCheck` task with idempotencyKey.
4. Keep `scheduledCheck` for legacy individual schedules.
5. Import `domainForAgent` from domain-tags and pass workspace's `domainMap`.

The `getCheckMcpServers()` function stays (per-check MCP override from YAML), but the agent-level fallback calls `resolveMcpServers()` from bootstrap instead of the hardcoded map.

- [ ] **Step 5: Create trigger/tasks/cron-tasks.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/src/trigger/cron-tasks.ts"`

Strip the Phoenix-specific tasks (plaid-daily-sync, nc-status-sync, hello-inbox-poll). Keep the pattern (task definition + schedule wrapper + assertSuccess helper) as a template. Add a comment explaining how to add workspace-specific cron tasks.

Create with just the `assertSuccess` helper and an example skeleton:

```typescript
import { task, schedules, logger, tags as tdTags } from "@trigger.dev/sdk/v3";
import { runShell, type ShellResult } from "../lib/shell.js";
import { domainTag } from "../lib/domain-tags.js";

const CRON_QUEUE = {
  name: "cron-tasks",
  concurrencyLimit: 2,
} as const;

const CRON_RETRY = {
  maxAttempts: 2,
  factor: 2,
  minTimeoutInMs: 10_000,
  maxTimeoutInMs: 60_000,
} as const;

export function assertSuccess(result: ShellResult, label: string): void {
  if (!result.success) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
    );
  }
}

// Add workspace-specific cron tasks below.
// Pattern: task definition + schedules.task wrapper
//
// export const myTask = task({
//   id: "my-task",
//   queue: CRON_QUEUE,
//   retry: CRON_RETRY,
//   maxDuration: 600,
//   run: async () => {
//     await tdTags.add(domainTag("operations"));
//     const result = await runShell({ command: "bash scripts/my-script.sh" });
//     assertSuccess(result, "my-task");
//     return { durationMs: result.durationMs };
//   },
// });
//
// export const myTaskSchedule = schedules.task({
//   id: "my-task-schedule",
//   cron: "0 6 * * *",
//   maxDuration: 60,
//   run: async () => { await myTask.trigger(); },
// });
```

- [ ] **Step 6: Create trigger/tasks/sync-skills.ts (stub)**

Create `trigger/tasks/sync-skills.ts`:

```typescript
/**
 * Skill sync task — Phase 2.
 *
 * Will propagate skill updates from nexaas/skills/ to subscribed workspaces.
 * For now, this is a placeholder.
 */

import { task, logger } from "@trigger.dev/sdk/v3";

export const syncSkills = task({
  id: "sync-skills",
  queue: { name: "skill-sync", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: { skillId?: string; workspaceId?: string }) => {
    logger.info("sync-skills is a Phase 2 stub", payload);
    return { status: "not-implemented" };
  },
});
```

- [ ] **Step 7: Create trigger/schedules/index.ts**

Create `trigger/schedules/index.ts`:

```typescript
/**
 * Cron schedule definitions.
 *
 * Re-exports all scheduled tasks so Trigger.dev discovers them.
 * Workspace-specific schedules are defined in their respective task files.
 */

// Skill runner schedules (batch dispatch)
export { dispatchFrequent, scheduledCheck } from "../tasks/run-skill.js";

// Cron task schedules (add workspace-specific exports here)
// export { myTaskSchedule } from "../tasks/cron-tasks.js";
```

- [ ] **Step 8: Create trigger/scripts/sync-schedules.ts**

Pull from Phoenix VPS: `ssh phoenix-services "cat /home/ubuntu/Phoenix-Voyages/trigger-dev/scripts/sync-schedules.ts"`

One change: update import path from `"../src/lib/yaml-checks.js"` to `"../lib/yaml-checks.js"`.

- [ ] **Step 9: Commit**

```bash
git add trigger/
git commit -m "feat: add trigger tasks and config from Phoenix (generalized)"
```

---

## Task 9: Create orchestrator bootstrap module

**Files:**
- Create: `orchestrator/bootstrap/index.ts`
- Create: `orchestrator/bootstrap/manifest-loader.ts`
- Create: `orchestrator/bootstrap/mcp-injector.ts`
- Create: `orchestrator/context/store.ts`

- [ ] **Step 1: Create directories**

```bash
mkdir -p orchestrator/bootstrap orchestrator/context
```

- [ ] **Step 2: Create orchestrator/bootstrap/manifest-loader.ts**

```typescript
/**
 * Workspace manifest loader.
 *
 * Reads workspace manifests from:
 * - Development: {repoRoot}/workspaces/{id}.workspace.json
 * - Production:  {NEXAAS_ROOT}/workspaces/{id}.workspace.json
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface WorkspaceManifest {
  id: string;
  name: string;
  workspaceRoot: string;
  claudeMd: {
    full: string;
    summary: string;
    minimal: string;
  };
  skills: string[];
  agents: string[];
  mcp: Record<string, string>;
  capabilities: Record<string, boolean>;
  trigger: {
    projectId: string;
    workerUrl: string;
  };
  domainMap?: Record<string, string>;
  context?: {
    threadTtlDays?: number;
    maxTurnsBeforeSummary?: number;
  };
}

const manifestCache = new Map<string, WorkspaceManifest>();

function getManifestDir(): string {
  const nexaasRoot = process.env.NEXAAS_ROOT;
  if (nexaasRoot) return join(nexaasRoot, "workspaces");
  // Development fallback: look relative to cwd
  return join(process.cwd(), "workspaces");
}

export async function loadManifest(workspaceId: string): Promise<WorkspaceManifest> {
  const cached = manifestCache.get(workspaceId);
  if (cached) return cached;

  const manifestPath = join(getManifestDir(), `${workspaceId}.workspace.json`);
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: WorkspaceManifest = JSON.parse(raw);

  if (manifest.id !== workspaceId) {
    throw new Error(`Manifest ID mismatch: expected "${workspaceId}", got "${manifest.id}"`);
  }

  manifestCache.set(workspaceId, manifest);
  return manifest;
}

export function clearManifestCache(): void {
  manifestCache.clear();
}
```

- [ ] **Step 3: Create orchestrator/bootstrap/mcp-injector.ts**

```typescript
/**
 * MCP server resolver.
 *
 * Given a workspace manifest and optional skill ID, returns the list of
 * MCP server names that should be loaded for this task.
 *
 * If a skill ID is provided, reads skills/_registry.yaml to get the
 * skill's MCP requirements and intersects with the workspace's available
 * MCP servers.
 *
 * If no skill ID, returns all MCP server names from the workspace manifest.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { WorkspaceManifest } from "./manifest-loader.js";

interface SkillRegistryEntry {
  id: string;
  mcp?: string[];
}

interface SkillRegistry {
  version: string;
  skills: SkillRegistryEntry[];
}

let _skillRegistry: SkillRegistry | null = null;

function loadSkillRegistry(): SkillRegistry {
  if (_skillRegistry) return _skillRegistry;

  const nexaasRoot = process.env.NEXAAS_ROOT || process.cwd();
  const registryPath = join(nexaasRoot, "skills", "_registry.yaml");

  try {
    // Use js-yaml if available, fall back to simple parse
    const yaml = require("js-yaml");
    const raw = readFileSync(registryPath, "utf-8");
    _skillRegistry = yaml.load(raw) as SkillRegistry;
  } catch {
    _skillRegistry = { version: "2.0", skills: [] };
  }

  return _skillRegistry;
}

export function resolveMcpServers(
  manifest: WorkspaceManifest,
  skillId?: string
): string[] {
  const availableServers = Object.keys(manifest.mcp);

  if (!skillId) return availableServers;

  const registry = loadSkillRegistry();
  const skill = registry.skills.find((s) => s.id === skillId);

  if (!skill || !skill.mcp || skill.mcp.length === 0) {
    return availableServers;
  }

  // Intersect: only MCP servers the skill needs AND the workspace has
  return skill.mcp.filter((s) => availableServers.includes(s));
}
```

- [ ] **Step 4: Create orchestrator/bootstrap/index.ts**

```typescript
/**
 * Workspace session bootstrap.
 *
 * Every Trigger task that needs workspace context calls createWorkspaceSession()
 * before doing anything else. Returns resolved workspace root, MCP servers,
 * and manifest — everything runClaude() needs.
 */

import { loadManifest, type WorkspaceManifest } from "./manifest-loader.js";
import { resolveMcpServers } from "./mcp-injector.js";

export interface WorkspaceSession {
  workspaceId: string;
  workspaceRoot: string;
  mcpServers: string[];
  manifest: WorkspaceManifest;
}

export async function createWorkspaceSession(
  workspaceId: string,
  options?: { skillId?: string; threadId?: string }
): Promise<WorkspaceSession> {
  const manifest = await loadManifest(workspaceId);
  const mcpServers = resolveMcpServers(manifest, options?.skillId);

  return {
    workspaceId,
    workspaceRoot: manifest.workspaceRoot,
    mcpServers,
    manifest,
  };
}

export { loadManifest, type WorkspaceManifest } from "./manifest-loader.js";
export { resolveMcpServers } from "./mcp-injector.js";
```

- [ ] **Step 5: Create orchestrator/context/store.ts (stub)**

```typescript
/**
 * Conversation context store — Phase 2.
 *
 * Will persist conversation state across task invocations using
 * thread IDs (from email Message-ID, webhook correlation ID, etc.).
 */

export interface ConversationContext {
  threadId: string;
  workspaceId: string;
  skillId?: string;
  turns: Array<{ role: string; content: string; timestamp: Date }>;
  summary?: string;
}

export async function loadConversationContext(
  _threadId: string
): Promise<ConversationContext | null> {
  // Phase 2: implement with Postgres
  return null;
}

export async function saveConversationContext(
  _threadId: string,
  _context: Partial<ConversationContext>
): Promise<void> {
  // Phase 2: implement with Postgres
}
```

- [ ] **Step 6: Commit**

```bash
git add orchestrator/
git commit -m "feat: add orchestrator bootstrap module (workspace sessions)"
```

---

## Task 10: Create platform docker-compose and database schema

**Files:**
- Create: `platform/docker-compose.yml`
- Create: `platform/.env.example`
- Create: `database/schema.sql`

- [ ] **Step 1: Create directories**

```bash
mkdir -p database/migrations database/seed
```

- [ ] **Step 2: Create platform/docker-compose.yml**

Use the spec from SCAFFOLD.md section 1.1. This is the Trigger.dev v4 self-hosted stack with:
- `trigger-webapp` (port 3040)
- `trigger-supervisor` (privileged, docker socket)
- `postgres` (16-alpine, healthcheck)
- `redis` (7-alpine, healthcheck)
- `minio` (ports 9000, 9001, healthcheck)

Copy the full docker-compose content from the scaffold SCAFFOLD.md section 1.1 verbatim.

- [ ] **Step 3: Create platform/.env.example**

```bash
# Platform stack environment
TRIGGER_DB_PASSWORD=             # strong password
TRIGGER_SECRET_KEY=              # generate: openssl rand -hex 32
TRIGGER_APP_ORIGIN=              # https://trigger.yourdomain.com
TRIGGER_LOGIN_ORIGIN=            # https://trigger.yourdomain.com
MAGIC_LINK_SECRET=               # generate: openssl rand -hex 32
ENCRYPTION_KEY=                  # generate: openssl rand -hex 32
TRIGGER_WORKER_API_KEY=          # from Trigger.dev dashboard
WHITELISTED_EMAILS=              # your email

MINIO_USER=nexaas
MINIO_PASSWORD=                  # strong password
```

- [ ] **Step 4: Create database/schema.sql**

Convert existing `engine/db/schema.sql` from SQLite to Postgres syntax, then append the new tables from the scaffold. Key conversions:
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`
- `TEXT DEFAULT (datetime('now'))` → `TIMESTAMPTZ DEFAULT NOW()`
- `TEXT` for JSON → `JSONB`
- Remove `IF NOT EXISTS` from index creation (Postgres handles this differently)

Include all existing tables (events, event_runs, job_queue, chat_sessions, chat_messages, bus_events, token_usage, ops_alerts, ops_health_snapshots, companies, users) plus new tables from scaffold:
- workspaces
- conversation_contexts
- skill_feedback
- skill_proposals
- skill_versions
- workspace_skills

And all indexes from both sources.

- [ ] **Step 5: Commit**

```bash
git add platform/docker-compose.yml platform/.env.example database/
git commit -m "chore: add platform docker-compose and unified Postgres schema"
```

---

## Task 11: Create operational scripts

**Files:**
- Create: `scripts/start-worker.sh`
- Create: `scripts/trigger-dev-worker.service`
- Create: `scripts/provision-workspace.sh`

- [ ] **Step 1: Create scripts/start-worker.sh**

Based on Phoenix's `start-worker.sh`, parameterized:

```bash
#!/usr/bin/env bash
# Wrapper script for Trigger.dev dev worker
# Ensures proper stdout/stderr handling for systemd journald
set -euo pipefail

# Default to repo root, override with TRIGGER_DIR env var
TRIGGER_DIR="${TRIGGER_DIR:-$(dirname "$0")/..}"
cd "$TRIGGER_DIR"

# Source environment if .env exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"

# Ensure Claude nesting detection is cleared
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

# Suppress interactive prompts under systemd
export CI=true

# Cap concurrent runs to prevent memory spikes from parallel Claude Code processes
# Each Claude CLI: ~1.2-1.6 GB. Tune MAX_CONCURRENT based on VPS RAM.
MAX_CONCURRENT="${MAX_CONCURRENT_RUNS:-5}"

exec ./node_modules/.bin/trigger dev \
  --skip-update-check \
  --max-concurrent-runs "$MAX_CONCURRENT" \
  --log-level log \
  2>&1
```

Make executable: `chmod +x scripts/start-worker.sh`

- [ ] **Step 2: Create scripts/trigger-dev-worker.service**

Based on Phoenix's systemd service, parameterized:

```ini
[Unit]
Description=Nexaas Trigger.dev Worker
Documentation=https://trigger.dev/docs
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/nexaas
ExecStart=/opt/nexaas/scripts/start-worker.sh
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nexaas-worker

# Environment
EnvironmentFile=/opt/nexaas/.env
Environment=NODE_ENV=production
Environment=TRIGGER_DIR=/opt/nexaas

# Resource limits — cap to prevent OOM cascade
LimitNOFILE=65536
MemoryMax=6G
MemoryHigh=5G
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create scripts/provision-workspace.sh**

Copy from scaffold zip (`/tmp/nexaas-scaffold/provision-workspace.sh`). This is the full provisioning script that:
- Creates workspace directory on client VPS
- Syncs subscribed skills
- Syncs MCP configs
- Syncs workspace manifest
- Installs Node.js + Trigger.dev worker
- Configures systemd service

Make executable: `chmod +x scripts/provision-workspace.sh`

- [ ] **Step 4: Commit**

```bash
git add scripts/start-worker.sh scripts/trigger-dev-worker.service scripts/provision-workspace.sh
git commit -m "feat: add operational scripts (worker launcher, systemd, provisioning)"
```

---

## Task 12: Update CLAUDE.md and .gitignore

**Files:**
- Replace: `CLAUDE.md`
- Modify: `.gitignore`

- [ ] **Step 1: Replace CLAUDE.md**

Replace the entire contents of `CLAUDE.md` with the scaffold zip's `CLAUDE.md` (from `/tmp/nexaas-scaffold/CLAUDE.md`). This reflects the v2 architecture: Trigger.dev execution model, skill authoring guide, workspace manifest format, environment setup, and "What NOT to Do" section.

- [ ] **Step 2: Update .gitignore**

Read the current `.gitignore` and append new entries for the v2 structure:

```
# Trigger.dev
.trigger/
node_modules/

# Platform data
platform/postgres-data/
platform/redis-data/
platform/minio-data/

# Build output
dist/
```

Do not remove any existing entries.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .gitignore
git commit -m "docs: update CLAUDE.md for v2 architecture"
```

---

## Task 13: Install dependencies and verify TypeScript compiles

**Files:**
- Modified: `package.json` (lock file generated)

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- Import paths may need `.js` extension for ESM (e.g., `"./manifest-loader.js"`)
- `require("js-yaml")` in mcp-injector.ts may need a dynamic import or the `js-yaml` types

- [ ] **Step 3: Verify trigger.config.ts is recognized**

```bash
npx trigger.dev@latest dev --help
```

Confirm no config errors.

- [ ] **Step 4: Commit**

```bash
git add package-lock.json
git commit -m "chore: install dependencies and verify TypeScript compiles"
```

---

## Task 14: Final verification and cleanup

- [ ] **Step 1: Verify directory structure matches spec**

```bash
# Confirm all new directories exist
ls -d trigger/lib trigger/tasks trigger/schedules trigger/scripts \
  orchestrator/bootstrap orchestrator/context \
  skills mcp/configs agents/ops-monitor workspaces templates \
  platform database/migrations scripts
```

- [ ] **Step 2: Verify framework assets moved**

```bash
# Confirm MCP configs are in new location
ls mcp/configs/ | wc -l   # should be 16

# Confirm agents moved
ls agents/ops-monitor/     # should show config.yaml, prompt.md

# Confirm skills moved
ls skills/contribute.md skills/health-check.md
```

- [ ] **Step 3: Verify engine and dashboard untouched**

```bash
# Engine still has all its files
ls engine/server.py engine/api/__init__.py engine/orchestrator/event_engine.py

# Dashboard still has its files
ls dashboard/package.json dashboard/app/layout.tsx
```

- [ ] **Step 4: Verify git status is clean**

```bash
git status
```

All changes should be committed. No untracked files except `node_modules/` (gitignored).

- [ ] **Step 5: Review commit history**

```bash
git log --oneline v2-foundation --not main
```

Expected commits (in order):
1. `chore: add root TypeScript + Trigger.dev config for v2`
2. `refactor: move framework/ assets to mcp/, agents/, skills/`
3. `feat: add MCP and skill registries`
4. `feat: add skill, prompt, and workspace templates`
5. `feat: add workspace manifests for nexaas-core and phoenix-voyages`
6. `feat: add trigger libs from Phoenix (claude, shell, telegram, yaml-lite)`
7. `feat: add trigger libs from Phoenix (domain-tags, yaml-checks)`
8. `feat: add trigger tasks and config from Phoenix (generalized)`
9. `feat: add orchestrator bootstrap module (workspace sessions)`
10. `chore: add platform docker-compose and unified Postgres schema`
11. `feat: add operational scripts (worker launcher, systemd, provisioning)`
12. `docs: update CLAUDE.md for v2 architecture`
13. `chore: install dependencies and verify TypeScript compiles`
