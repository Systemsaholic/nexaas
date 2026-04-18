# Nexaas + Nexmatic — Build Status

**Last updated:** 2026-04-17
**Current phase:** Phoenix fully migrated — framework features + PA system building

---

## Strategic Sequence

```
Phase 1: Build Nexaas framework runtime        ✓ DONE
Phase 2: Prove Nexaas on Phoenix (own company) ✓ DONE (19/19 flows migrated)
Phase 2.5: Framework features + PA system      ✓ DONE
Phase 3: Launch Nexmatic on proven framework   ← IN PROGRESS
Phase 4: Onboard Nexmatic clients organically
```

## Phoenix Deployment Results (overnight 2026-04-16 → 2026-04-17)

**Worker uptime:** 6.7+ hours, zero crashes
**WAL entries:** 1,373+
**Total skill runs:** 1,000+

### Shell skills (100% success rate)
- hello-inbox-poll: 109+ completions, 0 failures
- nc-status-sync: 179+ completions, 0 failures
- lead-sync-all: 101+ completions, 0 failures

### AI skills (pillar pipeline)
- email-sorting: 11+ completions through full agentic loop (Claude + MCP tools)
- Confirmed: multi-turn tool use, palace WAL recording, cost tracking, per-turn audit

### Migration scorecard
- 9 Trigger.dev schedules disabled
- 3 shell skills running at 100% reliability
- 3 AI skills converted from shell hacks to proper pillar pipeline execution
- 10 Trigger.dev schedules remaining (higher-risk flows, pending migration)

Phoenix proof happens BEFORE Nexmatic launch. This ensures the framework is battle-tested on real production workloads before clients depend on it.

---

## What's Done

### Repos (Day 1 — complete)

- [x] `github.com/Systemsaholic/nexaas` — framework repo, restructured as monorepo
- [x] `github.com/Systemsaholic/nexmatic` — business repo, 7 workspace packages
- [x] GitHub Packages auth configured (Systemsaholic org, private)
- [x] Deploy key for nexmatic repo on ops VPS
- [x] LICENSE file (proprietary, named grants, lawyer-review notice)

### Documentation (complete)

- [x] `docs/architecture.md` — 23-section framework architecture (Nexaas-only)
- [x] `docs/glossary.md` — 85+ terms covering both Nexaas and Nexmatic
- [x] `docs/migration-guide.md` — agnostic guide for migrating from any automation system
- [x] `docs/README.md` — doc index with reading order
- [x] `CLAUDE.md` — updated for BullMQ, pgvector, pillar pipeline, Nexaas/Nexmatic split
- [x] `nexmatic/docs/nexmatic.md` — business layer documentation (14 sections)
- [x] `nexmatic/docs/v1-refactor-plan.md` — execution plan with all locked decisions

### Palace Substrate (Day 2 — complete)

- [x] Migration `012_palace_substrate.sql` — 19 tables, 2 views, pgvector extension
  - Palace metadata on events (wing/hall/room, run tracking, waitpoints)
  - Closets + room compaction state + staleness telemetry
  - WAL with hash chain + operator signature columns
  - Operator identity + signing keys
  - Embeddings table with HNSW index (pgvector)
  - skill_runs denormalized index
  - Transactional outbox
  - Ops alerts, client sessions, recovery codes
  - GDPR: pii_keys, pii_redactions, pii_subjects
  - Backup history, framework versions
- [x] `@nexaas/palace` package — fully implemented
  - `palace.ts` — enter(), PalaceSession (writeDrawer, walkRoom, openClosets, createWaitpoint)
  - `wal.ts` — appendWal with hash chain + retry, verifyWalChain
  - `embeddings.ts` — upsertEmbedding, searchSimilar via pgvector
  - `db.ts` — Postgres pool with transaction support
  - `types.ts`, `closets.ts`, `waitpoints.ts` — type definitions
  - `index.ts` — public API exports

### Registries (Day 2 — complete)

- [x] `capabilities/_registry.yaml` — 10 capabilities at Stage Experimental
- [x] `capabilities/model-registry.yaml` — 4 tiers, 4 providers, Voyage-3 embedding
- [x] `palace/ontology.yaml` — 10 wings with named halls

### Runtime (Day 2-3 — IMPLEMENTED)

- [x] `pipeline.ts` — runSkillStep() with full CAG→RAG→Model→TAG→Engine flow
- [x] `models/gateway.ts` — ModelGateway with tier resolution, retry, fallback chain, cost tracking
- [x] `models/providers/anthropic.ts` — Claude SDK integration with tool-use formatting
- [x] `models/providers/openai.ts` — GPT SDK + openai-compatible endpoint support
- [x] `models/registry.ts` — YAML registry loader, tier resolver, cost estimator
- [x] `tag/route.ts` — TAG Option C layered policy, override enforcement, WAL audit
- [x] `cag/assemble.ts` — palace walking, contract injection, run history, staleness telemetry
- [x] `rag/retrieve.ts` — Voyage-3 embeddings + pgvector search + hash fallback for dev
- [x] `engine/apply.ts` — all 5 routing outcomes with WAL + dashboard projections
- [x] `run-tracker.ts` — skill_runs state transitions
- [x] `subagent.ts` — L1 sub-agent invocation (STUB — not needed for basic flows)

### BullMQ Execution (Day 3 — IMPLEMENTED)

- [x] `bullmq/connection.ts` — shared Redis connection
- [x] `bullmq/queues.ts` — per-workspace queues, enqueue, delayed, cron scheduling
- [x] `bullmq/worker.ts` — sandboxed job processing through the pillar pipeline
- [x] `bullmq/outbox-relay.ts` — Postgres outbox → BullMQ job relay with crash recovery
- [x] `bullmq/dashboard.ts` — Bull Board embedded as framework-level feature
- [x] `worker.ts` — entry point: boots worker + outbox relay + Bull Board + health endpoint

### CLI (Day 3 — IMPLEMENTED)

- [x] `cli/init.ts` — full VPS setup (prereqs, DB, migrations, config, operator, signing key, systemd)
- [x] `cli/status.ts` — health check (worker, Redis, Postgres, pgvector, palace, WAL, active runs)
- [x] `cli/verify-wal.ts` — WAL chain verification (incremental, full, from-id)

### Nexmatic Repo (Day 1 — initial structure)

- [x] Monorepo with 7 packages: ops-console, client-dashboard, auth, library, mcp-servers, factory, shared
- [x] All existing business-layer code moved from nexaas
- [x] Client dashboard preserved (copilot chat, TAG gates, billing, Plaid, Stripe, NextAuthJS)
- [x] Ops Console preserved (53 routes, fleet views, terminal)
- [x] 12 Claude Code slash commands preserved as factory seed
- [x] Deploy/provision scripts preserved
- [x] Workspace manifests preserved

---

## What's Ready for Phoenix

The core framework is functionally complete for deploying to Phoenix:

| Component | Status |
|---|---|
| Palace API (drawers, WAL, embeddings) | **DONE** |
| Pillar pipeline (CAG→RAG→Model→TAG→Engine) | **DONE** |
| ModelGateway (Anthropic + OpenAI + fallback) | **DONE** |
| TAG Option C policy enforcement | **DONE** |
| BullMQ worker + queues + outbox relay | **DONE** |
| Bull Board dashboard (framework-level) | **DONE** |
| `nexaas init` command | **DONE** |
| `nexaas status` command | **DONE** |
| `nexaas verify-wal` command | **DONE** |

### What's still needed before first skill runs on Phoenix

| Item | Status | Est. effort |
|---|---|---|
| End-to-end smoke test on this VPS | NOT STARTED | 0.5-1 day |
| npm install + TypeScript compilation | NOT STARTED | 0.5 day |
| Test `nexaas init` on Phoenix VPS | NOT STARTED | 0.5 day |
| `/migrate-flow` slash command | NOT STARTED | 3-5 days |
| First skill migration (heartbeat) | NOT STARTED | 0.5 day |

---

## What's Remaining (full list, dependency-ordered)

### Phase 1: Framework Runtime (must complete before Phoenix)

1. **Implement ModelGateway** — Anthropic SDK integration, tier resolution from model-registry.yaml, cost tracking, WAL logging
2. **Implement OpenAI fallback** in ModelGateway — fallback chain, tool-use normalization
3. **Implement TAG route** — manifest loading, contract loading, Option C enforcement, WAL logging of overrides
4. **Implement CAG assemble** — skill manifest loading, behavioral contract loading, palace walking, closet + live-tail reading, staleness telemetry, prompt assembly
5. **Implement RAG retrieve** — Voyage-3 API call for embeddings, pgvector search, room scoping, cascade strategy
6. **Implement engine apply** — auto_execute (drawer write + MCP call + next step enqueue), approval_required (waitpoint creation + channel notification), escalate, flag, defer
7. **BullMQ integration** — wrap runSkillStep as BullMQ job handler, sandboxed processors, per-workspace concurrency, graceful shutdown
8. **Outbox relay** — systemd service polling nexaas_memory.outbox, enqueuing to BullMQ, marking processed
9. **Sub-agent invocation** — narrowed palace scope, separate model call, typed return
10. **`nexaas init` command** — prerequisite installer, migration runner, config generator, operator bootstrap, service installer, health verifier
11. **`nexaas status` command** — check worker, Redis, Postgres, WAL chain, active runs
12. **End-to-end smoke test** — trivial skill through full pipeline on a test VPS

### Phase 2: Phoenix Proof (after runtime works)

13. **Install Nexaas on Phoenix VPS** alongside existing Trigger.dev
14. **`/migrate-flow` slash command** — reads source system inventory, walks through rewrite, generates skill manifest + prompt, handles disable/enable/shadow/revert
15. **Migrate Tier 1 flows** — heartbeat, health checks (zero-risk, prove the pipeline fires)
16. **Migrate Tier 2 flows** — inbox triage, TLN sync, lead sync (low-risk, prove MCP integration)
17. **Migrate Tier 3 flows** — social planner, email broadcast (medium-risk, prove waitpoints + outbound)
18. **Migrate cc-promote** — shadow mode first, then live (high-risk stress test)
19. **Migrate onboarding flows** — multi-day waitpoints, Telegram approval chains (hardest flows)
20. **Migrate accounting pipeline** — financial writes, shadow mode mandatory (highest stakes)
21. **Soak period** — all flows on Nexaas for 1+ week, monitoring, WAL verification
22. **Retire Trigger.dev on Phoenix** — stop Docker stack, archive, reclaim 4-6GB RAM

### Phase 3: Nexmatic Launch (after Phoenix is proven)

23. **Implement `@nexmatic/auth`** — NextAuthJS + WebAuthn + operators + sessions, shared by both apps
24. **Wire auth into ops-console** — login, session management, operator directory, fleet-wide scope
25. **Wire auth into client-dashboard** — login, passkey enrollment, per-action signing, recovery codes
26. **Implement Nexmatic factory** — `/new-skill`, `/new-flow` slash commands with authoring interview, archetype stamping, library RAG, contribution pipeline
27. **Implement `@nexmatic/library` infrastructure** — versioning, genealogy, contribution tracking, proposal flow
28. **Implement skill propagation** (`orchestrator/sync/`) — push proposals to subscribed workspaces
29. **Implement library curation** (`orchestrator/promotion/`) — experimental → canonical promotion
30. **Implement ops notifications** — Slack + email, tiered routing, ack/snooze, rate limiting
31. **Implement closet compaction task** — background worker, deterministic clustering, staleness escalation
32. **Implement waitpoint timeout reaper** — 60s cadence, timeout policy enforcement, reminder sending
33. **Implement WAL signing** — ed25519 library, operator key management, signed privilege actions, verify-wal with signature checking
34. **Implement client dashboard extensions** — WebAuthn wiring, session management, palace-backed writes, custom domains, recovery codes, usage reframing
35. **Implement Ops Console extensions** — fleet view, library inbox, proposal review, effective policy inspector, framework updates view, backup health, Factory Health metrics view
36. **`nexmatic-testlab` workspace** — conformance test suite, mock MCPs, test runner
37. **`nexmatic-ops` workspace** — dogfood with real Nexmatic internal automation
38. **Implement backup strategy** — per-workspace OVH bucket, daily backups, bi-weekly restore tests
39. **Implement GDPR** — PII encryption, key revocation, tombstone redaction, gdpr-export/delete/rectify ops actions
40. **Implement MCP scaffold** — `@nexaas/mcp-server` package, `nexaas create-mcp`, `/new-mcp` slash command
41. **Implement `nexaas dry-run`** — local skill testing with fixtures
42. **Implement skill versioning runtime** — multi-version loading, version pinning per run, deprecation GC
43. **Implement framework upgrade mechanism** — upgrade-workspace.sh, rollback, snapshot, smoke tests, 5-layer validation gate

### Phase 4: Client Onboarding

44. **First real Nexmatic client** — whatever they need, authored via the factory
45. **Second client** — cross-pollination test (library reuse, faster build time)
46. **Third client** — archetype extraction, library growth validation
47. **Factory Health metrics** — v1-done thresholds evaluated
48. **v1 declared done** (or extend as needed)

---

## Architectural Decisions (all locked)

All decisions are documented in `nexmatic/docs/v1-refactor-plan.md` Part XII. Key ones for quick reference:

- **BullMQ + Redis** per VPS (replacing Trigger.dev)
- **pgvector + Voyage-3** per VPS (replacing Qdrant)
- **ed25519 WAL signing** with WebAuthn for ops + clients
- **TAG Option C** layered policy
- **Tier-based model gateway** (cheap/good/better/best), Claude primary, OpenAI + self-hosted fallback
- **Unified auth** via `@nexmatic/auth` (NextAuthJS + WebAuthn, shared by both apps)
- **Organic library buildout** via factory, library grows through real client work
- **Factory is framework enforcement** — 100% usage target, bypassing is a violation
- **Semver skill versioning** with multi-version runtime
- **Per-workspace backup** to dedicated OVH project
- **GDPR** via cryptographic erasure + tombstone redaction
- **Slack + email** for ops notifications (Nexmatic-configured)
- **Nexaas standalone** — works without Nexmatic (Phoenix proves this)

---

## File Locations

### Nexaas Framework (`github.com/Systemsaholic/nexaas`)

```
/opt/nexaas/
├── LICENSE                           Proprietary with named grants
├── CLAUDE.md                         Framework working instructions
├── README.md                         Framework overview
├── package.json                      Monorepo root (workspaces)
├── capabilities/
│   ├── _registry.yaml                10 capabilities
│   └── model-registry.yaml           4 tiers, 4 providers
├── palace/
│   └── ontology.yaml                 10 wings with halls
├── database/
│   ├── schema.sql                    Base schema
│   └── migrations/
│       ├── 000-011                   Pre-palace migrations
│       └── 012_palace_substrate.sql  Palace substrate (19 tables)
├── packages/
│   ├── palace/src/                   IMPLEMENTED — palace API, WAL, embeddings
│   ├── runtime/src/                  STUBBED — pipeline, gateway, TAG, CAG, RAG
│   ├── factory/src/                  EMPTY — authoring primitives (later)
│   ├── ops-console-core/src/         EMPTY — console widgets (later)
│   └── cli/src/                      EMPTY — nexaas init, verify-wal, etc. (later)
├── orchestrator/                     Existing framework code (bootstrap, context, etc.)
├── mcp/servers/memory/               Framework memory MCP (629 LOC)
├── scripts/                          Health check scripts
└── docs/
    ├── architecture.md               Framework architecture
    ├── glossary.md                   Terminology
    ├── migration-guide.md            Migration from any system
    └── README.md                     Doc index
```

### Nexmatic Business (`github.com/Systemsaholic/nexmatic`)

```
/opt/nexmatic/
├── CLAUDE.md                         Business working instructions
├── README.md                         Business overview
├── package.json                      Monorepo root (workspaces)
├── packages/
│   ├── ops-console/                  53-route Ops Console (existing code)
│   ├── client-dashboard/             Full client dashboard (existing code)
│   ├── auth/                         EMPTY — unified auth (later)
│   ├── library/                      Skills, agents (existing scaffolding)
│   ├── mcp-servers/                  Plaid, open-meteo, configs (existing)
│   ├── factory/                      Archetypes, slash command stubs
│   └── shared/                       Channel adapters, email, promotion, sync
├── .claude/commands/                 12 existing slash commands
├── scripts/                          Deploy, provision, update scripts
├── workspaces/                       Client workspace manifests
└── docs/
    ├── nexmatic.md                   Business documentation
    └── v1-refactor-plan.md           Execution plan (all decisions locked)
```

---

## When Returning to Nexmatic

After Phoenix proof is complete, the Nexmatic work picks up at item #23 in the task list above. The framework runtime will be proven and stable. The work is:

1. **Auth package** (`@nexmatic/auth`) — the biggest single piece, shared by both apps
2. **Wire auth into both dashboards** — extend existing code, not rewrite
3. **Factory slash commands** — Nexmatic's `/new-skill`, `/new-flow` on top of framework factory primitives
4. **Library infrastructure** — versioning, propagation, curation
5. **Ops Console extensions** — fleet views, library management, monitoring
6. **Client dashboard extensions** — WebAuthn signing, palace-backed writes, custom domains
7. **Supporting infrastructure** — backups, GDPR, MCP scaffold, testing, upgrade mechanism

Estimated: 6-10 weeks of work after Phoenix proof. No hard deadline. Quality over speed.

---

## Key Context for Future Sessions

- Phoenix is a **Nexaas licensee**, not a Nexmatic client. It accesses Nexaas directly, no ops VPS routing.
- The existing Trigger.dev stack on Phoenix stays running during migration. Flows revert in <30 seconds.
- Envirotem has a live automation — excluded from v1 clean-slate. Stays on Trigger.dev until proven.
- Fairway and BSBC are test/play data — can be wiped clean.
- The client dashboard has real production-grade code (copilot chat, TAG gates, billing). Extend, don't rewrite.
- All architectural Q&A is complete — 25 questions across 4 batches, all locked. See Part XII of the refactor plan.
