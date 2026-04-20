# Nexaas Documentation

Canonical documentation for the Nexaas framework — context-aware AI execution for business automation.

## Reading Order

| Document | What it's for | When to read it |
|---|---|---|
| [`architecture.md`](./architecture.md) | The framework — Four Pillars, palace, capabilities, agents, skills, triggers, contracts, WAL, model gateway | First. Conceptual foundation. |
| [`deployment-patterns.md`](./deployment-patterns.md) | The two valid deployment modes — direct adopter (Phoenix-style) vs operator-managed (Nexmatic-style). Framework is tenant-agnostic by contract. | Early — decide which mode before deploying. |
| [`skill-authoring.md`](./skill-authoring.md) | Building skills — shell vs AI, nexaasification, model tiers, MCP integration, agentic loop, palace vs Claude Code memory | When you're ready to build. |
| [`deployment-ops.md`](./deployment-ops.md) | Deploying & operating — systemd config, legacy cleanup, worker startup, monitoring, backups, upgrading. Lessons from Phoenix production. | When deploying or troubleshooting. |
| [`fleet-protocol.md`](./fleet-protocol.md) | Wire contract between a client VPS worker and an operator-managed fleet dashboard (heartbeat + bootstrap registration). | When wiring operator-managed deployments. |
| [`migration-guide.md`](./migration-guide.md) | Moving from Trigger.dev, n8n, or any automation system to Nexaas — parallel operation, per-flow revert, risk tiers | When migrating existing systems. |
| [`glossary.md`](./glossary.md) | Terminology cheat sheet — every named concept in the system | As needed. |
| [`STATUS.md`](./STATUS.md) | Current build status — what's done, what's in progress | To understand project state. |

## What Nexaas Is

Nexaas is an opinionated framework for running context-aware AI execution. It assembles context from a per-workspace memory palace, retrieves relevant memories via semantic search, invokes Claude (or fallback providers) through a provider-agnostic gateway, enforces layered policy via TAG, and records every operation as hash-chained signed drawers in an append-only palace. Skills are written against abstract capabilities; workspace manifests bind capabilities to concrete integrations at install time.

## Nexaas vs Nexmatic vs direct adopters

**Nexaas** is the framework (this repo). Owned by Al via Systemsaholic. Licensed perpetually to Nexmatic, Phoenix Voyages, and Systemsaholic.

**Phoenix Voyages** is a **direct adopter** — runs Nexaas as a framework on its own VPS with no operator layer. Pays its own Anthropic bill, manages its own deployment cadence. The Nexaas canary.

**Nexmatic** is an **operator-managed commercial business** (`/opt/nexmatic/`) that sells AI automation to SMB clients using Nexaas as its execution framework. Ops Console, Client Dashboard, auth, library management, tiered billing, token metering. Separate repo, separate license.

Both usage modes are first-class — see [`deployment-patterns.md`](./deployment-patterns.md) for the details. The framework cannot tell which mode it's running in, by design.

## Key Directories

```
/opt/nexaas/
├── packages/palace/       Palace API, WAL, embeddings, signing
├── packages/runtime/      Pipeline, model gateway, worker, notifications
├── packages/cli/          15-command CLI
├── packages/factory/      Slash commands: /new-skill, /new-flow, /new-mcp, /nexaasify
├── capabilities/          Capability + model registries
├── palace/                Room ontology
├── database/migrations/   Schema (000-013)
├── mcp/servers/palace/    Palace MCP server
└── docs/                  This directory
```

## Factory Slash Commands

Available in any Claude Code session on a workspace VPS:

| Command | Purpose |
|---|---|
| `/new-skill` | Create a new AI or shell skill (8-phase interview) |
| `/new-flow` | Compose multiple skills into an automation flow |
| `/new-mcp` | Scaffold a new MCP server |
| `/nexaasify` | Convert existing automation to a Nexaas skill |
