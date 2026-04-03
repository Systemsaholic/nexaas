# Nexaas v2 Refactor Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Approach:** Option B — Phoenix-first, grow toward scaffold

## Context

Nexaas is being refactored from a Python FastAPI engine + Next.js dashboard into the Nexmatic platform backbone: Trigger.dev for task orchestration, Claude Code CLI for AI execution, multi-workspace support for SMB clients.

The scaffold (files.zip) defines the target architecture. The Phoenix Voyages VPS has a battle-tested Trigger.dev deployment that solved real stability problems (OOM crashes, MCP context overflow, process tree leaks). This spec merges the two: scaffold's directory structure and naming with Phoenix's proven execution model.

## Decision: Why Phoenix-First

The scaffold assumes Claude Agent SDK runs headlessly inside Trigger tasks. Phoenix proved the working pattern is Claude Code CLI subprocesses with:
- Process group cleanup (detached + negative PID kill)
- MCP server whitelisting (`--strict-mcp-config`) to stay within model context windows
- Memory caps via systemd (6G max per worker)
- Concurrency limits (`--max-concurrent-runs 5`, ~1.5GB per Claude process)
- Self-healing via global `onFailure` handler

Building on untested foundations means re-discovering every crash Phoenix already solved. The Claude Agent SDK can replace the CLI wrapper later — the interface is isolated in one file (`trigger/lib/claude.ts`).

---

## Target Directory Structure

```
nexaas/
├── CLAUDE.md                          # Updated for v2 architecture
├── CLAUDE.ops.md                      # Kept as-is
├── .env.example                       # All env vars documented
├── package.json                       # Root (trigger + orchestrator)
├── tsconfig.json                      # Root TS config
├── .triggerignore                     # Prevents file-watcher rebuild loops
│
├── trigger/                           # Phoenix trigger-dev/ reorganized
│   ├── trigger.config.ts              # Phoenix config (onFailure, skip lists)
│   ├── tasks/
│   │   ├── run-agent.ts               # Generic Claude runner (from Phoenix)
│   │   ├── run-skill.ts               # Generalized from Phoenix scheduled-check.ts
│   │   ├── sync-skills.ts             # Stub for Phase 2
│   │   └── cron-tasks.ts              # Shell-based crons (from Phoenix)
│   ├── schedules/
│   │   └── index.ts                   # Cron schedule definitions
│   ├── lib/
│   │   ├── claude.ts                  # CLI wrapper + OOM fixes (from Phoenix)
│   │   ├── shell.ts                   # Process group cleanup (from Phoenix)
│   │   ├── telegram.ts                # Notifications + dedup (from Phoenix)
│   │   ├── domain-tags.ts             # TD dashboard tagging (from Phoenix)
│   │   ├── yaml-checks.ts            # YAML check loader (from Phoenix)
│   │   └── yaml-lite.ts              # Minimal YAML parser (from Phoenix)
│   └── scripts/
│       └── sync-schedules.ts          # Schedule sync tool (from Phoenix)
│
├── orchestrator/                      # Workspace session layer (new, thin)
│   ├── bootstrap/
│   │   ├── index.ts                   # createWorkspaceSession()
│   │   ├── manifest-loader.ts         # Reads workspaces/{id}.workspace.json
│   │   └── mcp-injector.ts            # Resolves MCP servers from manifest
│   └── context/
│       └── store.ts                   # Stub for Phase 2
│
├── skills/                            # Skill registry (scaffold structure)
│   ├── _registry.yaml                 # Master skill index
│   ├── msp/                           # MSP skills (stubs for now)
│   └── README.md                      # Skill authoring guide
│
├── agents/                            # Promoted from framework/agents/
│   └── ops-monitor/
│       ├── config.yaml
│       └── prompt.md
│
├── mcp/                               # Moved from framework/mcp-servers/
│   ├── _registry.yaml                 # All 16 servers with ports + capabilities
│   └── configs/                       # All 16 existing YAML configs
│       ├── brave-search.yaml
│       ├── docuseal.yaml
│       ├── email.yaml
│       ├── fetch.yaml
│       ├── filesystem.yaml
│       ├── github.yaml
│       ├── groundhogg.yaml
│       ├── m365.yaml
│       ├── memory.yaml
│       ├── nextcloud.yaml
│       ├── playwright.yaml
│       ├── postgres.yaml
│       ├── sequential-thinking.yaml
│       ├── slack.yaml
│       ├── telegram.yaml
│       └── vaultwarden.yaml
│
├── workspaces/                        # Workspace manifests
│   ├── _template.workspace.json       # Blank template
│   ├── nexaas-core.workspace.json     # Nexaas own workspace
│   └── phoenix-voyages.workspace.json # Phoenix Voyages workspace
│
├── platform/                          # Docker stack
│   ├── docker-compose.yml             # Trigger.dev + Postgres + Redis + MinIO
│   └── .env.example
│
├── database/                          # Unified Postgres schema
│   ├── schema.sql                     # Full schema
│   └── migrations/                    # Numbered migration files
│
├── templates/                         # Skill, agent, workspace templates
│   ├── workspace.workspace.json
│   ├── skill.yaml
│   └── prompt.md
│
├── scripts/
│   ├── provision-workspace.sh         # Spin up new client VPS
│   ├── start-worker.sh                # Memory-safe worker launcher
│   ├── trigger-dev-worker.service     # Systemd unit template
│   ├── health-check.sh                # Existing
│   └── update.sh                      # Existing
│
├── dashboard/                         # Untouched (Phase 3)
├── engine/                            # Kept for now, retired after validation
└── docs/
```

---

## File Migration Map

### Moved via `git mv` (preserves history)

| Source | Destination |
|---|---|
| `framework/mcp-servers/*.yaml` (16 files) | `mcp/configs/*.yaml` |
| `framework/agents/ops-monitor/` | `agents/ops-monitor/` |
| `framework/skills/*.md` | `skills/` |
| `scripts/health-check.sh` | `scripts/health-check.sh` (stays) |
| `scripts/update.sh` | `scripts/update.sh` (stays) |
| `docker-compose.yml` | `platform/docker-compose.old.yml` |

### Pulled from Phoenix VPS (`ssh phoenix-services`)

| Phoenix Path | Destination | Generalization |
|---|---|---|
| `trigger-dev/src/lib/claude.ts` | `trigger/lib/claude.ts` | `WORKSPACE_ROOT` becomes parameter |
| `trigger-dev/src/lib/shell.ts` | `trigger/lib/shell.ts` | `cwd` defaults from passed workspace root |
| `trigger-dev/src/lib/telegram.ts` | `trigger/lib/telegram.ts` | As-is |
| `trigger-dev/src/lib/domain-tags.ts` | `trigger/lib/domain-tags.ts` | Strip Phoenix agent map, read from manifest |
| `trigger-dev/src/lib/yaml-checks.ts` | `trigger/lib/yaml-checks.ts` | `CHECKS_DIR` becomes parameter |
| `trigger-dev/src/lib/yaml-lite.ts` | `trigger/lib/yaml-lite.ts` | As-is |
| `trigger-dev/trigger.config.ts` | `trigger/trigger.config.ts` | Parameterize project ref + skip list |
| `trigger-dev/src/trigger/run-agent.ts` | `trigger/tasks/run-agent.ts` | As-is pattern |
| `trigger-dev/src/trigger/scheduled-check.ts` | `trigger/tasks/run-skill.ts` | Rename + generalize |
| `trigger-dev/start-worker.sh` | `scripts/start-worker.sh` | Parameterize paths |
| `trigger-dev/trigger-dev-worker.service` | `scripts/trigger-dev-worker.service` | Template with env vars |
| `trigger-dev/.triggerignore` | `.triggerignore` | As-is |
| `trigger-dev/tsconfig.json` | `tsconfig.json` | Adapt include paths |
| `trigger-dev/package.json` | `package.json` | Rename project, keep deps |

### Created new

| File | Source |
|---|---|
| `mcp/_registry.yaml` | Scaffold zip `_registry.yaml` |
| `skills/_registry.yaml` | Scaffold SCAFFOLD.md section 2.1 |
| `templates/skill.yaml` | Scaffold zip `skill.yaml` |
| `templates/prompt.md` | Scaffold zip `prompt.md` |
| `templates/workspace.workspace.json` | Scaffold zip `workspace.workspace.json` |
| `workspaces/_template.workspace.json` | Scaffold zip `workspace.workspace.json` |
| `workspaces/nexaas-core.workspace.json` | New (minimal) |
| `workspaces/phoenix-voyages.workspace.json` | New (based on Phoenix VPS config) |
| `platform/docker-compose.yml` | Scaffold SCAFFOLD.md section 1.1 |
| `platform/.env.example` | Scaffold env vars section |
| `database/schema.sql` | Scaffold DB schema section |
| `orchestrator/bootstrap/index.ts` | New |
| `orchestrator/bootstrap/manifest-loader.ts` | New |
| `orchestrator/bootstrap/mcp-injector.ts` | New |
| `orchestrator/context/store.ts` | Stub |
| `scripts/provision-workspace.sh` | Scaffold zip `provision-workspace.sh` |
| `CLAUDE.md` | Scaffold zip `CLAUDE.md` |
| `.env.example` | Scaffold env vars section |

### Kept untouched

- `dashboard/` — Phase 3
- `engine/` — kept until Trigger.dev validated
- `CLAUDE.ops.md` — still valid
- `examples/` — reference material

### Retired after migration confirmed

- `framework/` (emptied by moves, then removed)
- `engine/` (after Trigger.dev validated on at least one workspace)
- `templates/fresh/` (replaced by new templates)

---

## Generalization Strategy

### `trigger/lib/claude.ts`

Three changes to Phoenix code, zero changes to stability mechanics:

1. **`WORKSPACE_ROOT` becomes a parameter.** `runClaude()` accepts `workspaceRoot?: string` alongside existing options. Falls back to `process.env.WORKSPACE_ROOT` for backward compatibility.

2. **MCP config path resolves from workspace root.** `loadProjectMcpConfig()` takes an optional path parameter. Default: `{workspaceRoot}/.mcp.json`.

3. **Agent prompt resolution uses workspace root.** `loadAgentSystemPrompt()` resolves paths relative to passed workspace root.

Everything else stays identical: `spawn`, `detached: true`, process group kill via negative PID, `--strict-mcp-config`, stream-json parsing, SIGTERM-then-SIGKILL timeout escalation, `CLAUDECODE` env var cleanup.

### `trigger/lib/shell.ts`

One change: `cwd` defaults to passed parameter or `process.env.WORKSPACE_ROOT`. Process group cleanup, timeout escalation, logger streaming unchanged.

### `trigger/lib/domain-tags.ts`

Remove hardcoded `AGENT_DOMAIN_MAP`. Add `loadDomainMap(workspaceId)` that reads `domainMap` from workspace manifest. `domainForAgent()` accepts optional workspace map. Falls back to `"operations"`.

### `trigger/lib/yaml-checks.ts`

`CHECKS_DIR` becomes a function parameter: `loadAllChecks(checksDir?)`. Default: `{WORKSPACE_ROOT}/operations/memory/checks/`. All cron conversion (`checkToCron`), due-check calculation (`getDueChecks`), and prompt building (`buildCheckPrompt`) unchanged.

### `trigger/trigger.config.ts`

1. `project` already reads from `process.env.TRIGGER_PROJECT_REF`.
2. `dirs` changes from `["src/trigger"]` to `["tasks"]` to match new layout.
3. `onFailure` skip list extracted to a `const SKIP_SELF_HEAL: string[]` array at top of file instead of inline if-chains.

### `orchestrator/bootstrap/index.ts`

Thin data resolver, not an execution engine:

```typescript
export interface WorkspaceSession {
  workspaceId: string
  workspaceRoot: string
  mcpServers: string[]  // feeds into runClaude({ mcpServers })
  manifest: WorkspaceManifest
}

export async function createWorkspaceSession(
  workspaceId: string,
  options?: { skillId?: string; threadId?: string }
): Promise<WorkspaceSession> {
  const manifest = await loadManifest(workspaceId)
  const mcpServers = resolveMcpServers(manifest, options?.skillId)
  return { workspaceId, workspaceRoot: manifest.workspaceRoot, mcpServers, manifest }
}
```

### `orchestrator/bootstrap/manifest-loader.ts`

Reads `workspaces/{id}.workspace.json` from repo root (development) or `/opt/nexaas/workspaces/` (production, via `NEXAAS_ROOT` env var).

### `orchestrator/bootstrap/mcp-injector.ts`

Given a workspace manifest and optional skill ID:
1. If skill ID provided, reads `skills/_registry.yaml` to get the skill's MCP requirements
2. Cross-references with workspace manifest's `mcp` section for endpoint URLs
3. Returns `string[]` of MCP server names available for this task

---

## Operational Model

### Systemd Service (per VPS)

```ini
[Service]
MemoryMax=6G
MemoryHigh=5G
StartLimitBurst=5
RestartSec=30
```

Parameterized with `NEXAAS_WORKSPACE`, `NEXAAS_ROOT`, `WORKSPACE_ROOT`.

### Worker Launcher

```bash
exec trigger dev \
  --skip-update-check \
  --max-concurrent-runs 5 \
  --log-level log
```

Each Claude CLI process: ~1.2-1.6 GB. On a 22 GB VPS: 5 concurrent max leaves ~2 GB for OS + interactive sessions.

### Queue Separation

| Queue | Concurrency | Purpose |
|---|---|---|
| `claude-agents` | 3 | AI tasks (run-agent, run-skill) |
| `yaml-checks` | 2 | Scheduled YAML checks |
| `data-sync` | 2 | Scraping, syncing |
| `cron-tasks` | 2 | Shell-based cron replacements |

### Self-Healing

Global `onFailure` in `trigger.config.ts`:
- Triggers Claude diagnosis task for failed runs
- Skip list prevents loops (self-healer), noise (high-frequency tasks), and known-broken tasks
- Rate-limited Telegram alerts: 1 per task per 30 minutes
- If Claude reports a fix, re-triggers the original task

### Multi-Workspace Deployment

Each client VPS:
1. Gets `provision-workspace.sh` run against it
2. Receives synced skills (read-only), MCP configs, workspace manifest
3. Runs its own Trigger worker via systemd service
4. Connects to central Trigger.dev instance (or local self-hosted)

Skills are read-only from the workspace perspective. All changes flow through the Nexaas repo's `skills/` directory.

---

## What's Deferred

| Item | Phase | Why |
|---|---|---|
| Claude Agent SDK migration | Future | Replace `trigger/lib/claude.ts` internals when SDK is production-ready |
| Skill feedback loop | Phase 2 | `orchestrator/feedback/`, `orchestrator/promotion/` |
| Contamination scanning | Phase 2 | `orchestrator/feedback/sanitizer.ts` |
| Skill promotion pipeline | Phase 2 | `orchestrator/promotion/human-gate.ts` |
| Dashboard rewire | Phase 3 | Nexmatic branding, new routes, Trigger.dev realtime |
| Conversation context persistence | Phase 2 | `orchestrator/context/store.ts` (stub for now) |
| `engine/` retirement | After validation | Keep alongside until Trigger.dev confirmed working |

---

## Success Criteria

Phase 1 is complete when:
- [ ] New directory structure in place on `v2-foundation` branch
- [ ] All 16 MCP configs moved to `mcp/configs/`
- [ ] Phoenix Trigger.dev libs in `trigger/lib/` with generalized workspace root
- [ ] `trigger/tasks/run-agent.ts` runs a task via `createWorkspaceSession()`
- [ ] `trigger/trigger.config.ts` with parameterized onFailure
- [ ] Workspace manifests created for nexaas-core and phoenix-voyages
- [ ] `platform/docker-compose.yml` starts without errors
- [ ] `database/schema.sql` valid Postgres schema
- [ ] `scripts/start-worker.sh` and systemd service template ready
- [ ] `CLAUDE.md` updated for v2 architecture
- [ ] `engine/` and `dashboard/` untouched and still functional
