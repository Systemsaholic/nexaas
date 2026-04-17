# Nexaas + Nexmatic Documentation

This directory holds canonical documentation for both **Nexaas** (the framework) and **Nexmatic** (the business built on it). They are architecturally and legally separate; they are operationally launched together as v1.

## Start here

| Document | What it's for | When to read it |
|---|---|---|
| [`architecture.md`](./architecture.md) | The Nexaas framework — conceptual foundation, the Four Pillars, palace, capabilities, agents, skills, sub-agents, triggers, channels, contracts, WAL + signing, model gateway. Timeless, framework-only. | First. Read it before anything else if you're new. |
| [`skill-authoring.md`](./skill-authoring.md) | How to build skills — shell vs AI, nexaasification, model tiers, MCP integration, the agentic loop, migration workflow. Practical, hands-on. | Second. Read this when you're ready to build. |
| [`migration-guide.md`](./migration-guide.md) | Moving from Trigger.dev, n8n, or any automation system to Nexaas — parallel operation, per-flow revert, risk tiers. | When migrating existing systems. |
| [`glossary.md`](./glossary.md) | Terminology cheat sheet. Every named concept in the system, framework and business. | As needed, whenever a term trips you up. |

## The Nexaas / Nexmatic split

**Nexaas is the framework.** CAG, RAG, TAG, Contracts, and MemPalace-derived memory substrate. Runtime infrastructure. Provider-agnostic. Repository-owned by Al personally via Systemsaholic. Licensed perpetually and unconditionally to Nexmatic, Phoenix Voyages, and Systemsaholic; can be licensed to other entities in the future.

**Nexmatic is the business** that uses Nexaas as its execution framework to deliver AI business automation to SMB clients. Nexmatic builds and maintains a library of canonical skills and agent bundles, authors client-specific flows using the factory, and runs a fleet of per-client VPSes. Owned separately from Nexaas; a commercial consumer of the framework.

They are architecturally separable: Nexaas could power another business entirely, and Nexmatic could theoretically migrate to a different framework (though doing so would cost years of library rewriting). They ship together in v1 because each needs the other to launch, but they are built as distinct repositories with distinct licenses.

## What Nexaas is in one paragraph

Nexaas is an opinionated framework for running context-aware AI execution. It assembles context from a per-workspace memory palace, retrieves relevant memories via semantic search, invokes Claude (or fallback providers) through a provider-agnostic gateway, enforces layered policy via TAG, and records every operation as hash-chained signed drawers in an append-only palace. Skills are written against abstract capabilities; workspace manifests bind capabilities to concrete integrations at install time. Every privileged action is cryptographically signed. The framework provides primitives; consuming businesses build products on top.

## What Nexmatic is in one paragraph

Nexmatic is an AI business automation platform for SMB clients, built on Nexaas. Nexmatic sells per-client workspaces on per-client VPSes, with a Nexmatic-maintained library of canonical skills and agent bundles propagated to them. Clients get durable, context-aware automation for accounting, marketing, operations, and other business domains, with human-in-the-loop approvals via their own branded dashboard. Nexmatic's moat is the accumulated library of curated, proven skills — grown organically through real client work — combined with the factory that authors new flows faster than a from-scratch build.

## Document lifecycle

- **`architecture.md`** is stable. It changes when framework concepts evolve. Significant changes should be reviewed before merge.
- **`nexmatic.md`** is stable for the business layer. It changes when the business model, library structure, or ops processes evolve.
- **`v1-refactor-plan.md`** is a living execution document. It is edited as the plan progresses, open questions are answered, and scope changes. Commit messages should describe what changed and why.
- **`glossary.md`** grows additively as new terms are introduced. Terms are only removed when the underlying concept is removed from the system.

## Other documents in this directory

The following are legacy or supporting documents. They are not part of the canonical doc set and may be out of date. Treat as historical context or working notes:

- `architecture-guide-v4-gap-analysis.md` — earlier architecture analysis, predates the palace-substrate direction
- `architecture-v4-implementation-plan.md` — earlier implementation plan, superseded by `v1-refactor-plan.md`
- `next-steps.md` — working notes
- `token-optimization.md` — token usage analysis
- `trigger-dev-reference.md` — Trigger.dev v4 reference guide (historical, will be retired once BullMQ migration completes)
- `superpowers/` — working notes directory

When in doubt, trust `architecture.md`, `nexmatic.md`, and `v1-refactor-plan.md` over anything else in this directory.

## Contributing changes to docs

1. **Framework architectural changes**: edit `architecture.md` directly. Commit message should describe the conceptual change and its rationale.
2. **Business-layer changes**: edit `nexmatic.md` directly.
3. **Plan changes**: edit `v1-refactor-plan.md` directly. Open questions are answered in-place; week sequences can be reordered as long as dependencies are respected.
4. **New terms**: add to `glossary.md` alphabetically. Short entries fine, but state plainly whether a term belongs to Nexaas, Nexmatic, or both.
5. **Legacy docs**: do not edit without a clear reason. They're kept for historical context.

## Outside this directory

- [`/opt/nexaas/LICENSE`](../LICENSE) — Nexaas framework license (proprietary with named grants; lawyer review required before commercial operation)
- [`/opt/nexaas/CLAUDE.md`](../CLAUDE.md) — project-level instructions for Claude when working in this codebase
- [`/opt/nexaas/capabilities/_registry.yaml`](../capabilities/_registry.yaml) — canonical capability interface registry (created in v1 Week 1)
- [`/opt/nexaas/palace/ontology.yaml`](../palace/ontology.yaml) — canonical room ontology (created in v1 Week 1)
- [`/opt/nexaas/workspaces/`](../workspaces/) — client workspace manifests, source of truth for each deployment

## Note about the combined repository today

As of 2026-04-15, Nexaas and Nexmatic content both live in `/opt/nexaas/` as a combined repository. This is a transitional state. Week 1 Day 1 of the v1 refactor plan splits this into two repositories — `nexaas` (framework) and `nexmatic` (business) — with proper dependency management. After the split, the framework and business layers will live at separate locations under separate licenses.

See Part I of `v1-refactor-plan.md` for the split execution details.
