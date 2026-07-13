# Nexaas — Claude Working Instructions

This file instructs Claude on how to work inside the Nexaas framework codebase. Read `docs/` for deep understanding; read this file for operational rules.

## Architecture at a Glance

**Nexaas is the framework**: the Four Pillars (CAG, RAG, TAG, Contracts) running over a palace memory substrate, with BullMQ execution, pgvector retrieval, ed25519 operator signing, and a provider-agnostic model gateway. Owned by Al via Systemsaholic. Licensed perpetually to Nexmatic and other named entities.

**Nexmatic is a separate repo** (`/opt/nexmatic/`). It's the business layer built on Nexaas — Ops Console, Client Dashboard, auth, library management. Do not mix framework code with Nexmatic code.

**Read before working:**
- `docs/architecture.md` — Nexaas framework (conceptual foundation)
- `docs/skill-authoring.md` — how to build skills
- `docs/glossary.md` — terminology reference
- `docs/contracts.md` — public contract registries (WAL ops, env vars, worker routes; CI-guarded)

## Execution Model

- **Pillar pipeline** is the execution path for every skill step: CAG → RAG → Model → TAG → engine actions
- **BullMQ** (backed by Redis, per workspace VPS) is the job execution runtime. Sandboxed processors prevent worker leaks
- **Model gateway** (`@nexaas/runtime/models`) handles ALL model invocations with tier-based selection. Claude is primary; OpenAI and self-hosted are fallbacks
- **Claude Agent SDK** (`@anthropic-ai/sdk`) runs Claude headlessly via the model gateway. NEVER spawn `claude` CLI as a subprocess for skill execution
- **Claude Code CLI** is installed on every VPS as an **ops troubleshooting tool** — operators SSH in and run `claude` for maintenance. NOT for skill execution
- **MCP servers** provide tools to AI skills via the stdio protocol. Skills declare which MCP servers they need in their manifests
- **Palace** is the memory substrate. State lives in drawers, not in skill code local variables

## Skill Authoring

Skills live in `nexaas-skills/[category]/[skill-name]/` on each workspace VPS and contain:
- `skill.yaml` — manifest: id, version, triggers, execution type, MCP servers, palace rooms, TAG routing
- `prompt.md` — model prompt with Self-Reflection Protocol (required for AI skills)

See `docs/skill-authoring.md` for the full reference including model tiers, MCP integration, and the agentic loop.

### Creating Skills

Use the factory slash commands — they enforce framework conventions:
- `/new-skill` — create a new AI or shell skill (8-phase interview)
- `/new-flow` — compose multiple skills into an automation flow
- `/new-mcp` — scaffold a new MCP server
- `/nexaasify` — convert an existing automation (YAML check, script, cron job) to a Nexaas skill

### Self-Reflection Protocol

Every AI skill prompt MUST end with:

```
## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [one paragraph — generic capability description,
no client names, no specific data, no workspace-specific context]
```

## CLI Reference

The `nexaas` CLI provides these commands for workspace management:

```
nexaas init --workspace <id>           Set up Nexaas on a VPS
nexaas status                          Runtime health check
nexaas health                          Detailed 10-point health report
nexaas conformance [--json]            Prove the install works end-to-end ($0 AI spend)
nexaas register-skill <skill.yaml>     Register skill with BullMQ scheduler
nexaas trigger-skill <skill.yaml>      Fire a skill manually
nexaas dry-run <skill.yaml> [--live]   Validate a skill manifest
nexaas library list|contribute|install|diff|promote|feedback
nexaas propagate check|push|accept|reject
nexaas alerts [list|test|config]       Notification management
nexaas backup [run|list|test|schedule] Database backup/restore
nexaas upgrade [--check|--migrate|--channel <c>|--to <tag>|--rollback]  Framework updates
nexaas create-mcp <name>              Scaffold MCP server
nexaas gdpr export|delete|redact|subjects|audit
nexaas verify-wal [--full]            WAL chain integrity
nexaas config [key] [value]           Workspace configuration
```

## Palace Room Ontology

State lives in rooms. Skills declare which rooms they read (retrieval) and write (output). Top-level wings:

- `inbox.*` — incoming messages and events awaiting processing
- `events.*` — domain events for triggering and audit
- `knowledge.*` — static or slow-changing reference material
- `library.*` — skill library (skills, canonical, feedback)
- `accounting.*`, `marketing.*`, `operations.*` — domain-specific business data
- `notifications.*` — pending outbound notifications and alert history
- `ops.*` — ops-visible state (escalations, errors, audits, health)

## Palace Memory vs Claude Code Memory

**Palace memory** (nexaas_memory in Postgres, via `palace_write` MCP tool): Use for business state, operational decisions, skill findings — anything other skills, sessions, or team members need to see.

**Claude Code memory** (local `.claude/` files): Use ONLY for personal operator preferences. NOT for business state.

**When in doubt, use the palace.** Palace writes are WAL-audited. Claude Code memory is siloed and invisible to skills.

## Worker Systemd Service

The `nexaas-worker.service` runs the BullMQ worker, outbox relay, and Bull Board dashboard.

**Production runs compiled JS (#37):** the unit invokes `node --conditions=production /opt/nexaas/packages/runtime/dist/worker.js`. Each workspace package has its own `tsconfig.json` and emits to its own `dist/` via `npm run build`. Conditional `exports` in each `package.json` route cross-package imports (`@nexaas/palace`, `@nexaas/runtime`, `@nexaas/integration-sdk`) to `dist/index.js` when `--conditions=production` is set, and to `src/index.ts` otherwise. `nexaas init` and `nexaas upgrade` both run `npm run build` before (re)starting the service; `nexaas upgrade` also auto-migrates legacy tsx-based units in place.

**Dev/test runs TS source via tsx:** scripts and ad-hoc invocations use `node --import tsx packages/runtime/src/worker.ts` (or `npx tsx ...`). Without `--conditions=production`, Node falls back to the `default` exports condition, which points at `src/index.ts` — tsx transforms on the fly. Test scripts under `scripts/` follow this pattern.

**Critical deployment lessons (from Phoenix production):**
- Use direct node invocation, NOT npm/npx wrappers — snap node through npm swallows stdout and escapes cgroup cleanup
- Use `KillMode=mixed` + `ExecStopPost=fuser -k` to prevent orphan processes holding the port
- The in-process health monitor must NOT use `execSync` to curl its own Express server (deadlock)
- BullMQ scheduler-spawned jobs may arrive with empty `data` — worker must fall back to `process.env.NEXAAS_WORKSPACE`
- Shell/AI skill executors create their own `skill_runs` records — the worker must NOT duplicate them
- On startup: reconcile orphaned `skill_runs` (status='running' with stale last_activity) and deduplicate stale BullMQ repeatables

## Git Workflow — feature branch + PR (2026-07-08)

**Never commit or push directly to `main`** — branch protection enforces this
(PR required, admins included, no force pushes). For every change:

1. Branch from main: `git checkout -b fix/<slug>` or `feat/<slug>`.
2. Commit + push the branch, then open a PR: `gh pr create --fill`.
3. Merge it yourself once green: `gh pr merge --squash --delete-branch`
   (0 approvals required — solo merges are fine; the PR exists for review
   visibility and history, not gatekeeping).
4. After merge on a box that runs the worker: `git checkout main && git pull`,
   rebuild if `packages/` changed, `sudo systemctl restart nexaas-worker`.

Squash-merge is the default so main stays one-commit-per-change. Urgent
production fixes follow the same path — the PR round-trip is ~30 seconds
with `gh`.

## Release Policy

Clients consume **tagged semver releases (`vX.Y.Z`) via channels** — git branches `channel/stable` and `channel/canary` fast-forwarded by ops to release tags. **`main` is never deployed to clients.** Workspaces opt in with `nexaas upgrade --channel stable|canary`; deployments with no channel configured keep legacy tracking-branch behavior. `nexaas upgrade --to vX.Y.Z` pins a hotfix tag; `nexaas upgrade --rollback` returns to the previous ref (code only — migrations are never reverted, so **every migration must be backward-compatible one release**: additive columns nullable/defaulted, no renames/drops of anything the prior release reads, removals two-phase across releases). Every release section in `CHANGELOG.md` lists its migrations. Full procedure: `docs/releases.md`.

## Deploying to a New Workspace

When deploying Nexaas to a workspace for the first time:

1. Run `nexaas init --workspace <id>` — installs prerequisites, creates DB, applies migrations, generates .env, installs systemd service
2. Archive or remove ALL legacy automation artifacts — Trigger.dev code, old framework directories, `claude --print` scripts, legacy Python automations
3. Update the workspace CLAUDE.md — replace any Trigger.dev/legacy sections with Nexaas-only instructions. Add the palace vs Claude Code memory guidance blockquote
4. Seed the palace: `nexaas seed-palace <workspace-root>`
5. Create skills via `/new-skill` or convert existing automations via `/nexaasify`
6. Register skills: `nexaas register-skill <path>`
7. Set up automated backups: `nexaas backup schedule`
8. Verify: `nexaas status`, `nexaas health`

**Legacy cleanup checklist** (prevents Claude Code from reverting to old patterns):
- [ ] Archive `trigger-dev/` directories to `~/.archive-legacy-<date>/`
- [ ] Disable and archive Trigger.dev systemd services
- [ ] Remove Docker images and volumes for Trigger.dev
- [ ] Archive old `framework/` and `nexaas-framework/` directories
- [ ] Archive legacy Python scripts from workspace root
- [ ] Remove migration docs that reference old systems as "source"
- [ ] Remove old planning docs that reference Trigger.dev as core tech
- [ ] Verify CLAUDE.md contains ZERO references to Trigger.dev as an active system

## Environment Variables

Set in `.env` (never committed):

**Required:**
- `NEXAAS_WORKSPACE` — workspace ID
- `NEXAAS_ROOT` — path to nexaas installation (default: /opt/nexaas)
- `NEXAAS_WORKSPACE_ROOT` — path to workspace files
- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string (default: redis://localhost:6379)
- `ANTHROPIC_API_KEY` — for AI skills

**Optional:**
- `VOYAGE_API_KEY` — for RAG embeddings
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` — for Telegram notifications
- `RESEND_API_KEY` + `OPS_ALERT_EMAIL` — for email notifications
- `NEXAAS_WORKER_CONCURRENCY` — parallel job limit (default: 5)
- `NEXAAS_WORKER_PORT` — health/dashboard port (default: 9090)
- `NEXAAS_BACKUP_DIR` — backup storage path (default: /var/backups/nexaas)
- `NEXAAS_WORKSPACE_MANIFEST_DIR` — where to read the workspace manifest (default: `/opt/nexmatic/workspaces/` — operator-managed mode; set to `/etc/nexaas/workspaces` or similar for direct-adopter mode)
- `NEXAAS_FLEET_ENDPOINT` + `NEXAAS_FLEET_TOKEN` — fleet-heartbeat target (operator-managed only; leave unset for direct adopters — sender becomes a silent no-op)
- `NEXAAS_PA_TIMEOUT_MS` — per-request PA handler timeout (default: 120000 = 2 min)
- `NEXAAS_PA_MAX_RETRIES` — max delivery attempts for a PA-routed pending drawer before the marker transitions to `dead` and an `ops_alert` is emitted (default: 3; minimum: 1)
- `NEXAAS_PA_NORMAL_HOLD_MINUTES` — hold duration for `urgency: normal` PA notifications before they become claimable. Lets workspaces batch/digest if they choose (default: 15)
- `NEXAAS_PA_LOW_RELEASE_HOUR` — local-time hour at which `urgency: low` PA notifications become claimable (default: 7, i.e. 07:xx)
- `NEXAAS_PA_LOW_RELEASE_MINUTE` — minute within the configured hour for low-tier release (default: 30, i.e. 07:30 by default)
- `NEXAAS_WAL_RETENTION_DAYS` — enable WAL retention policy (default: unset = keep forever)
- `NEXAAS_WAITPOINT_MAX_TIMEOUT_DAYS` — upper bound on inbound-match waitpoint timeouts (default: 1 day). Raise for state-machine hold patterns (e.g. `7` for week-scale approval loops). See #66.
- `NEXAAS_SILENT_FAILURE_THRESHOLD` — consecutive-failure count that triggers a silent-failure alert (default: 5; minimum: 2). See #69.
- `NEXAAS_SILENT_FAILURE_CHANNEL_ROLE` — channel_role to emit silent-failure alerts to (unset = feature disabled). Bind this role to an operator-facing channel in the workspace manifest. See #69.
- `NEXAAS_MCP_POOL_ENABLED` — reuse MCP subprocesses across ai-skill runs instead of spawning fresh per run (default: unset = spawn-per-run). Saves 3–5s per run on skills declaring many MCPs. Applies to `ai-skill.ts` only for now; other call sites (subagent, notification-dispatcher, pa/service) stay on spawn-per-run. See #63.
- `NEXAAS_CROSS_VPS_BEARER_TOKEN` — bearer token for ALL mutating `/api/*` worker endpoints (#217). Generated per-VPS by `nexaas init`; unset = endpoints open (legacy direct-adopter posture). See `docs/security-surface.md`.
- `NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS` — secondary accepted token during rotation (dual-accept window). Remove + restart to complete a rotation. See `docs/security-surface.md`.
- `NEXAAS_WORKER_BIND` — worker HTTP bind address (default: all interfaces). Set `127.0.0.1` on direct-adopter VPSes with no off-box callers. See `docs/security-surface.md`.

## Separation of Concerns — Nexaas vs Nexmatic

**Nexaas (`/opt/nexaas/`, `Systemsaholic/nexaas`)** is the FRAMEWORK. It is:
- Owned and maintained by the Nexaas dev team
- Agnostic to specific clients, workspaces, and business configurations
- Responsible for: palace, runtime, pillar pipeline, CLI, MCP protocol, worker, ingest, PA service, factory commands
- Issues tracked at: `github.com/Systemsaholic/nexaas/issues`

**Nexmatic (`/opt/nexmatic/`, `Systemsaholic/nexmatic`)** is the BUSINESS. It is:
- Owned and maintained by the Nexmatic dev team (separate team)
- Responsible for: Ops Console, Client Dashboard, add-ons, billing, onboarding, workspace manifests, deploy scripts, Zernio integration
- Issues tracked at: `github.com/Systemsaholic/nexmatic/issues`

**Rules:**
- Nexmatic code NEVER modifies Nexaas framework code. If Nexmatic needs a framework change, it files an issue on the Nexaas repo.
- Nexaas code NEVER contains client-specific data, workspace manifests, or business logic.
- Workspace manifests live in `/opt/nexmatic/workspaces/` — NOT in the Nexaas repo.
- Nexaas issues are NOT Nexmatic issues and vice versa. Each team tracks its own.
- When working in one repo, do not make changes to the other without explicit coordination.

## What NOT to Do

- Do NOT write Python. This is a TypeScript codebase.
- Do NOT use SQLite. Postgres only.
- Do NOT build custom job queues. BullMQ is the execution runtime.
- Do NOT spawn `claude` CLI as a subprocess for skill execution. Use `execution.type: ai-skill` in the manifest.
- Do NOT use Trigger.dev. It has been fully replaced by BullMQ.
- Do NOT use Qdrant. Use pgvector + Voyage-3 for vector retrieval.
- Do NOT hardcode model names. Use `model_tier: cheap|good|better|best`.
- Do NOT put client data in skill definitions.
- Do NOT commit `.env` or API keys.
- Do NOT store business state in Claude Code's local memory. Use the palace.
- Do NOT create automations outside the factory (`/new-skill`, `/new-flow`, `/nexaasify`).

## Directory Reference

```
/opt/nexaas/
├── CLAUDE.md                           This file
├── LICENSE                             Proprietary with named grants
├── packages/
│   ├── palace/src/                     Palace API, WAL, embeddings, signing
│   ├── runtime/src/                    Pipeline, gateway, TAG, CAG, RAG, worker, notifications
│   ├── manifest/src/                   Skill-manifest schema + loader (single source of truth)
│   ├── cli/src/                        nexaas CLI (commands listed above)
│   └── factory/commands/               /new-skill, /new-flow, /new-mcp, /nexaasify
├── capabilities/
│   ├── _registry.yaml                  10 capabilities
│   └── model-registry.yaml             4 tiers, 4 providers
├── palace/
│   └── ontology.yaml                   10 wings
├── database/
│   └── migrations/                     numbered, append-only (WAL substrate, workspace config, ...)
├── mcp/servers/palace/                 Palace MCP server (8 tools)
├── docs/                               Architecture, glossary, migration guide, skill authoring, contracts
└── scripts/                            Health checks, deployment helpers
```
