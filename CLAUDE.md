# Nexaas — AI Business Automation Platform
# Backbone of Nexmatic

## What This Is

Nexaas is the proprietary framework powering Nexmatic — an AI business
automation platform for SMB clients. It is NOT a generic framework.
It is purpose-built for running durable, context-aware AI workflows
across multiple isolated client workspaces.

## Architecture

```
Nexmatic (product)
└── Nexaas (this repo — the backbone)
    ├── Skills          Reusable AI capabilities (the neuro-network)
    ├── Agents          Configured Claude instances
    ├── MCP             Tool server registry and configs
    ├── Orchestrator    Bootstrap, context, feedback, promotion
    ├── Trigger         Task definitions (Trigger.dev)
    ├── Workspaces      Client workspace manifests
    └── Dashboard       Next.js client-facing UI
```

## Execution Model

- **Trigger.dev** (self-hosted) handles all task scheduling, queuing,
  retries, and observability. Do NOT build custom job queues.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) runs Claude
  headlessly inside Trigger tasks. Do NOT spawn Claude CLI subprocesses.
- **Bootstrap module** (`orchestrator/bootstrap/`) provides full workspace
  context to every task. Always call `createWorkspaceSession()` first.
- **MCP servers** run as persistent services on each VPS.
  Tasks connect to them via manifest-declared HTTP endpoints.

## Skill Authoring

Every skill lives in `skills/[category]/[skill-name]/` and contains:
- `skill.yaml` — manifest (id, version, resources, inputs, outputs)
- `prompt.md` — Claude instructions for this skill
- `task.ts` — Trigger.dev task wrapper
- `schema.ts` — Zod input/output validation
- `tests/` — test cases proving it works

### Self-Reflection Protocol

Every skill prompt MUST end with:

```
## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [one paragraph — generic capability description,
no client names, no specific data, no workspace-specific context]
```

This marker is captured by the feedback collector and enters the
skill promotion pipeline.

## Workspace Manifests

Each workspace is declared in `workspaces/[id].workspace.json`.
The manifest defines:
- Which skills this workspace subscribes to
- Which MCP servers are available (with endpoints)
- Workspace capabilities (playwright, docker, bash, etc.)
- Trigger.dev project ID and worker URL

Skills are read-only from the workspace's perspective.
Workspaces consume skills — they do not own them.

## Skill Evolution Pipeline

```
Skill runs in workspace
  → Claude outputs SKILL_IMPROVEMENT_CANDIDATE
  → feedback/collector.ts captures signal
  → feedback/sanitizer.ts scans for contamination (2-pass)
  → If CLEAN: promotion/human-gate.ts sends review notification
  → You approve/reject via Trigger.dev waitpoint
  → If approved: sync/propagator.ts pushes to subscribed workspaces
```

Never manually edit a skill that was promoted from a workspace.
Always go through the pipeline.

## Context Continuity

Conversation state persists across task invocations via
`orchestrator/context/store.ts`. The thread ID (from email
Message-ID, webhook correlation ID, etc.) is the key.

Tasks are stateless. Context is not. Always:
1. Resolve thread ID from source data
2. Pass thread ID to `createWorkspaceSession()`
3. Session includes prior conversation history automatically

## Directory Reference

```
platform/           Trigger.dev docker-compose stack
skills/             Skill registry (source of truth)
  _registry.yaml    Master skill index
agents/             Agent definitions
mcp/                MCP server configs and registry
  _registry.yaml    All MCP servers, ports, capabilities
orchestrator/
  bootstrap/        createWorkspaceSession() — start here
  context/          Conversation state persistence
  feedback/         Skill improvement signal capture
  promotion/        Skill version promotion pipeline
  sync/             Skill propagation to workspaces
trigger/            Trigger.dev task definitions
  trigger.config.ts Points at self-hosted instance
  tasks/            All Trigger tasks
workspaces/         Workspace manifests (one per client)
dashboard/          Next.js UI (Nexmatic-branded)
database/           Unified Postgres schema + migrations
templates/          Skill, agent, workspace templates
```

## Environment

Set in `.env` (never committed):
- `NEXAAS_WORKSPACE` — workspace ID for this Trigger project
- `NEXAAS_ROOT` — path to nexaas repo on VPS (`/opt/nexaas`)
- `TRIGGER_API_URL` — self-hosted Trigger.dev endpoint
- `ANTHROPIC_API_KEY` — Anthropic API key
- `DATABASE_URL` — shared Postgres connection string

## What NOT to Do

- Do NOT write Python. This is a TypeScript codebase.
- Do NOT use SQLite. Postgres only.
- Do NOT build custom job queues. Trigger.dev handles this.
- Do NOT spawn `claude` CLI subprocess. Use Claude Agent SDK.
- Do NOT put client data in skill definitions.
- Do NOT commit `.env` files or API keys.
- Do NOT modify skills directly in workspace repos.
  All skill changes go through nexaas/skills/ and the pipeline.
- Do NOT skip `createWorkspaceSession()`. Every task starts with it.

## Trigger.dev Patterns

```typescript
// Every task follows this pattern
export const mySkillTask = task({
  id: "skill-name",
  queue: { name: "workspace-tasks", concurrencyLimit: 5 },
  run: async (payload) => {
    const session = await createWorkspaceSession(
      process.env.NEXAAS_WORKSPACE!,
      { skillId: "category/skill-name", threadId: payload.threadId }
    )
    // ... use session.cwd, session.mcpServers, session.systemPrompt
  }
})
```

## MCP Server Registry

All MCP servers are documented in `mcp/_registry.yaml`.
Each entry includes: name, port, capabilities, required env vars.
Bootstrap resolves MCP endpoints from workspace manifest + registry.

## Getting Started (new workspace)

1. Copy `templates/workspace.workspace.json` → `workspaces/[client-id].workspace.json`
2. Fill in workspace root, skill subscriptions, MCP endpoints
3. Create Trigger.dev project for the workspace
4. Install Trigger worker on client VPS
5. Set `NEXAAS_WORKSPACE=[client-id]` in Trigger project env vars
6. Run `scripts/provision-workspace.sh [client-id]`
