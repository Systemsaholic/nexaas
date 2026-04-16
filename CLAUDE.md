# Nexaas + Nexmatic — Claude Working Instructions

This file instructs Claude on how to work inside this codebase. Read the `docs/` directory for deep understanding; read this file for operational rules.

## Transitional State Notice (2026-04-15)

This repository is currently a **combined** Nexaas + Nexmatic codebase. As part of v1, it will be **split into two repositories**:
- `nexaas` — the framework (Systemsaholic-owned, proprietary license with named grants)
- `nexmatic` — the business (depends on `@nexaas/*` packages)

The split is Week 1 Day 1 work. Until then, both layers live here. When working in this repo, be aware of which layer you are touching and preserve the architectural split even in the combined state. See `docs/v1-refactor-plan.md` Part I for the split execution plan.

## Architecture at a Glance

**Nexaas is the framework**: the Four Pillars (CAG, RAG, TAG, Contracts) running over a MemPalace-derived palace substrate, with BullMQ execution, pgvector retrieval, ed25519 operator signing, and a provider-agnostic model gateway. Owned personally by Al via Systemsaholic. Licensed perpetually to Nexmatic and other named entities.

**Nexmatic is the business** built on Nexaas. Sells AI business automation to SMB clients via per-client Nexaas workspaces. Maintains a library of canonical skills, authors client-specific flows via the factory, and runs a fleet of per-client VPSes.

**Read before working:**
- `docs/architecture.md` — Nexaas framework (conceptual foundation)
- `docs/nexmatic.md` — Nexmatic business (business layer)
- `docs/v1-refactor-plan.md` — current execution plan
- `docs/glossary.md` — terminology reference

## Execution Model (current state, will evolve during v1)

- **Pillar pipeline** is the execution path for every skill step: CAG → RAG → Model → TAG → engine actions
- **BullMQ** (backed by Redis, per workspace VPS) is the job execution runtime. Sandboxed processors prevent worker leaks
- **Transactional outbox** pattern bridges Postgres (state) and Redis (jobs) for cross-store atomicity
- **Model gateway** (`@nexaas/runtime/models`) handles ALL model invocations with tier-based selection and provider-agnostic fallback. Claude is primary; OpenAI and self-hosted are fallbacks
- **Claude Agent SDK** (`@anthropic-ai/sdk`) runs Claude headlessly via the model gateway. NEVER spawn `claude` CLI as a subprocess for skill execution
- **Claude Code CLI** is installed on every VPS as an **ops troubleshooting tool** — operators SSH in and run `claude` for maintenance. NOT for skill execution
- **Bootstrap module** (`orchestrator/bootstrap/`) provides full workspace context to every skill step. Always call `createWorkspaceSession()` first
- **MCP servers** run as persistent services on each VPS. Skills connect to them via capability bindings resolved from the workspace manifest
- **Palace** is the memory substrate. State lives in drawers, not in skill code local variables. Waitpoints are dormant drawers

## Skill Authoring

Skills live in `skills/[category]/[skill-name]/` (in the Nexmatic repo after split) and contain:
- `skill.yaml` — manifest: id, version, triggers, capability requirements, outputs with TAG routing, palace footprint, sub-agent declarations, model tier per step
- `prompt.md` — model prompt with Self-Reflection Protocol
- `task.ts` — (optional) thin glue for pre/post logic

Most skills do NOT need `task.ts`. The pillar pipeline runs automatically from the manifest + prompt.

Skills are written against **capabilities**, not concrete MCPs. Workspaces bind capabilities to specific implementations at install time.

### Self-Reflection Protocol

Every skill prompt MUST end with:

```
## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [one paragraph — generic capability description,
no client names, no specific data, no workspace-specific context]
```

This marker is captured by the feedback collector and enters the skill promotion pipeline.

## Workspace Manifests

Each workspace is declared in `workspaces/<id>.workspace.json`. The manifest contains:
- `capability_bindings` — capability → MCP mapping
- `channel_bindings` — role → channel kind + MCP + config
- `installed_agents` — active agent bundles
- `behavioral_contract` — tone, approval posture, skill overrides, schema extensions
- `custom_domains` — any client-owned domains pointing at this VPS
- `model_policy` — provider and tier caps

Skills are read-only from the workspace's perspective. Workspaces consume skills; they do not own them.

## Palace Room Ontology

State lives in rooms. Skills declare which rooms they read (retrieval) and write (output). Top-level wings:

- `inbox.*` — incoming messages and events awaiting processing
- `events.*` — domain events for triggering and audit
- `knowledge.*` — static or slow-changing reference material
- `accounting.*`, `marketing.*`, `operations.*`, etc. — domain-specific business data
- `notifications.*` — pending outbound notifications
- `ops.*` — ops-visible state (escalations, errors, audits, health)
- `personas.*` — reserved for L3 sub-agents (future)

Adding a new top-level wing requires an ontology update. Halls and rooms are added by skill manifests against registered patterns.

## TAG Option C Layered Policy

TAG enforces two layers:

1. **Skill manifest** declares routing defaults per output (`routing_default`, `overridable`, `overridable_to`)
2. **Behavioral contract** can override within the envelope the skill author permits

Every override (accepted or denied) is signed to the WAL with authorization chain. The Ops Console shows effective policy per workspace × skill.

## WAL + Operator Signing

Every meaningful operation writes a WAL row with a sha256 hash chained to the previous row. Privileged actions (workspace genesis, skill install, agent install, contract edits, ops waitpoint resolutions, skill propagation, WAL redactions) carry ed25519 signatures from the authorizing operator. Verification runs bi-daily incremental + weekly full-chain.

**Client admins sign their own privileged actions** via per-action WebAuthn gestures. Approvals, contract edits, and configuration changes by clients are cryptographically non-repudiable, not just session-authenticated.

## Skill Evolution Pipeline

```
Skill runs in workspace
  → Model outputs SKILL_IMPROVEMENT_CANDIDATE
  → feedback/collector captures signal as drawer
  → Sanitizer scans for contamination
  → If CLEAN: library curator reviews (currently Al manually)
  → If approved: promoted to canonical, propagates as proposal
  → Workspaces subscribed to the skill see the proposal
  → Ops reviews and pushes to running workspaces
```

Improvements propagate as **proposals**, NOT automatic updates. Minor versions may auto-apply; major versions always require review.

Never manually edit a skill that was promoted from a workspace. Always go through the pipeline.

## Context Continuity

State persists across runs via the palace, not via explicit variables. Tasks are stateless; the palace is the state. Resume is walking back into a room.

For a skill run:
1. Resolve thread/run id from source data
2. Pass it to `createWorkspaceSession()`
3. CAG walks the palace to assemble full context including prior run history

## Directory Reference (current combined state)

```
platform/           Legacy Trigger.dev docker-compose (being retired)
skills/             Skill library (becomes Nexmatic library after split)
  _registry.yaml    Master skill index
agents/             Agent definitions (becomes Nexmatic agent bundles)
mcp/                MCP server configs and registry
  _registry.yaml    All MCP servers, ports, capabilities
orchestrator/
  bootstrap/        createWorkspaceSession() — start here
  palace/           Palace API (add during Week 1)
  pipeline/         Pillar pipeline runtime (add during Week 2)
  cag/ rag/ tag/    Pillar implementations (add during Week 2)
  runtime/          Sub-agent, model gateway, runTracker (add during Week 2)
  feedback/         Skill improvement signal capture
  promotion/        Skill promotion and proposal flow (REWRITE during Week 2)
  sync/             Skill propagation to workspaces (REWRITE during Week 2)
  domains/          Custom domain management (add during Week 3)
trigger/            Legacy Trigger.dev tasks (being replaced by pillar pipeline)
workspaces/         Workspace manifests (one per client)
dashboard/          Ops Console shell (becomes Nexmatic Ops Console after split)
client-dashboard/   STUB — nuke during Week 1
database/           Postgres schema + migrations
capabilities/       Capability registry (add during Week 1)
palace/             Palace ontology registry (add during Week 1)
docs/               Architecture, Nexmatic, refactor plan, glossary
```

After the split:
- `/opt/nexaas/` contains the framework (installed via npm from `@nexaas/*` packages)
- `/opt/nexmatic/` contains the business layer (library, agents, MCP implementations, Ops Console, client dashboard)

## Environment Variables

Set in `.env` and `.env.platform` (never committed):

**Platform secrets (Tier 1, sops-encrypted on ops VPS, pushed to each client VPS):**
- `ANTHROPIC_API_KEY` — shared across clients (usage billed to Nexmatic, capped per-workspace as internal margin protection)
- `VOYAGE_API_KEY` — embedding model for RAG
- `PLAID_CLIENT_ID`, `PLAID_SECRET` — Nexmatic-registered Plaid app
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` — Nexmatic-registered QBO app
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_SECRET`, etc.

**Per-workspace:**
- `NEXAAS_WORKSPACE` — workspace ID for this VPS
- `NEXAAS_ROOT` — path to nexaas runtime on this VPS
- `DATABASE_URL` — local Postgres connection string
- `REDIS_URL` — local Redis connection string
- `WORKSPACE_TOKEN_KEY` — per-VPS master key for encrypting client integration tokens

Per-client OAuth tokens live in `integration_connections` table, encrypted with `WORKSPACE_TOKEN_KEY`.

## What NOT to Do

- Do NOT write Python. This is a TypeScript codebase.
- Do NOT use SQLite. Postgres only.
- Do NOT build custom job queues. **BullMQ** is the execution runtime; use it.
- Do NOT spawn `claude` CLI as a subprocess for skill execution. Use the **model gateway** (which uses Claude Agent SDK under the hood for Claude calls). The `claude` CLI on client VPSes is for ops troubleshooting only.
- Do NOT use Trigger.dev in new code. Trigger.dev is being replaced by BullMQ during the v1 refactor. Existing Trigger tasks will be migrated.
- Do NOT use Qdrant in new code. Use **pgvector + Voyage-3** for vector retrieval. The legacy Qdrant container on the ops VPS is being retired.
- Do NOT put client data in skill definitions.
- Do NOT commit `.env`, `.env.platform`, or API keys.
- Do NOT modify skills directly in workspace repos. All skill changes go through the canonical library and propagation pipeline.
- Do NOT skip `createWorkspaceSession()`. Every skill step starts with it.
- Do NOT mix Nexaas framework code with Nexmatic business code. Respect the architectural split even in the combined repo state. Framework code belongs in the Nexaas layer; business code belongs in the Nexmatic layer.
- Do NOT leak provider/model/token information to client-facing surfaces. The client dashboard shows usage in client-meaningful units (runs, approvals), NOT token counts or provider names.
- Do NOT perform privileged actions without operator signing. Every skill install, agent install, contract edit, waitpoint resolution by ops, skill propagation, and WAL redaction must be signed.

## Pillar Pipeline Pattern

Every skill step invocation goes through:

```typescript
// pseudocode — full implementation lands in @nexaas/runtime
export async function runSkillStep(params: {
  workspace: string
  runId: string
  skillId: string
  stepId: string
  resumedWith?: Record<string, unknown>
}) {
  const session = await createWorkspaceSession(params.workspace, {
    skillId: params.skillId,
    runId: params.runId,
  })

  const palaceSession = palace.enter({ ...params })

  const context = await CAG.assemble({ session, palace: palaceSession, step: params.stepId })
  const retrieval = await RAG.retrieve({ session, context, rooms: context.retrievalRooms })
  const output = await ModelGateway.execute({
    tier: context.modelTier,
    messages: buildMessages(context, retrieval),
    system: context.systemPrompt,
    tools: context.tools,
    workspaceId: params.workspace,
    runId: params.runId,
    stepId: params.stepId,
  })
  const routing = await TAG.route({ output, skillId: params.skillId, workspace: params.workspace })

  for (const action of routing.actions) {
    await engine.apply(action, { session, palace: palaceSession, runId: params.runId, stepId: params.stepId })
  }
}
```

Skill authors never write this — it's the runtime's responsibility. Skills declare their intent via manifest + prompt.

## MCP Server Registry

All MCP servers are documented in `mcp/_registry.yaml`. Each entry includes: name, capabilities provided, required env vars, stage (Experimental / Converging / Stable).

Bootstrap resolves MCP endpoints from the workspace manifest's capability bindings plus the registry.

**Capability-first discipline**: skills declare what capabilities they need, not which MCPs. MCPs implement capabilities. Workspace manifests bind.

## Getting Started with a New Workspace

After v1 is complete, workspace provisioning is a single Ops Console operation. During v1 development:

1. Copy `templates/workspace.workspace.json` → `workspaces/<client-id>.workspace.json`
2. Fill in capability bindings, channel bindings, behavioral contract, installed agents
3. Run `scripts/deploy-instance.sh <workspace-id> <vps-ip> <admin-email> <app-origin>`
4. The script installs prerequisites, deploys Nexaas + Nexmatic, applies DB migrations, seeds platform secrets, and starts the runtime
5. Client admin enrolls a passkey at their dashboard's first login
6. First flow authoring via `/new-flow` slash command in a Claude Code session on the client VPS

## Session Persistence and Task Resumption

State across durable pauses lives in the palace, not in process memory. When a waitpoint resolves:
1. Channel adapter calls `resolveWaitpoint(signal, resolution, actor)`
2. Runtime clears the dormant signal, writes a resolution drawer
3. Outbox relay enqueues the next step's job in BullMQ
4. Worker picks up the job, calls `runSkillStep` with `resumedWith` populated
5. CAG reassembles the context including the resolution drawer
6. The skill proceeds from the resumed step

There is no event-log replay. No step-level memoization. No determinism constraints. Skills are stateless across pauses; the palace is the state.

## Open Questions

See `docs/v1-refactor-plan.md` Part XI for the live tracker of open architectural questions pending decisions. Do not invent answers to these — surface them to the user.
