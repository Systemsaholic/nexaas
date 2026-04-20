# Nexaas — Build Status

**Last updated:** 2026-04-20
**Current phase:** Reliability + channel-framework epic landing. Phoenix (canary) on `main`.

## Sessions 2026-04-19 → 2026-04-20

### Reliability & hardening batch

Multiple production bugs surfaced and fixed on Phoenix. Every fix is
workspace-agnostic — applies identically to direct-adopter and
operator-managed deployments (see `deployment-patterns.md`).

**Issues closed:**

- `#25` agentic-loop guardrails — spend cap, repetition detector, error streak, token caps
- `#26` per-turn `max_tokens` raised 4096 → 16000 (was truncating tool_use JSON)
- `#27` workspace-level 429 backoff — BullMQ queue pause with auto-resume
- `#28` output verification — skill-declared verify blocks gate run completion
- `#29` workspace_config vs workspace_kv schema split
- `#30` preflight gate on ai-skill manifests — opt-in empty-work suppression
- `#31` scheduler wipe on worker restart — self-heal from manifests replaces destructive reconcile
- `#32` Anthropic retry wrapper — 5-attempt exp-backoff with jitter, 60s per-call timeout
- `#33` /health endpoint hang — async exec in shell-skill + worker handlers, listen-first startup
- `#34` pg-pool idle-disconnect crash — added 'error' listener
- `#35` missing migration for framework_heartbeat — applied on Phoenix
- `#36` orphan `running` skill_runs — periodic 20-min reaper alongside startup reaper
- `#38` messaging-inbound/outbound v0.2 — channel-agnostic field renames
- `#41` workspace manifest JSON schema — Zod + fail-open loader
- `#44` deployment-patterns doc — direct adopter vs operator-managed

**Issues open (staged or pending dependency):**

- `#27`, `#28`, `#30`, `#32`, `#34`, `#36` — shipped, awaiting 24h Phoenix observation
- `#37` — compile TS → JS in production (follow-up to #33 tsx/esbuild investigation)
- `#39` Stage 1 shipped — inbound-message trigger dispatcher (awaits #42 for end-to-end)
- `#40` Stage 1 shipped — notifications.* outbound subscriber (awaits #45 Stage 1b for skill-side)
- `#42` — telegram-adapter refactor (capstone, depends on #38/#39/#40/#41)
- `#43` — capability registry YAML parseability (quality follow-up)
- `#45` Stage 1a shipped — TAG types + approval-request drawer. Stages 1b–5 remain.

**Key commits (on `main`):**

```
fc70633 approval-callback resolver
4fd76ee #39 Stage 1 — inbound-message trigger dispatcher
472d7f5 #40 Stage 1 — notifications.* outbound subscriber
bb93498 #45 Stage 1a — TAG types + approval-request drawer
4026256 #44 deployment-patterns docs
f7e10c9 #38 messaging v0.2 renames
30e3f4b #41 workspace manifest schema
82117a2 harden 5/5 — WAL retention (opt-in)
5777cb2 harden 4/5 — outbox relay reentrance + backoff
6ec54f2 harden 3/5 — MCP client lifecycle
d0ccfe5 harden 2/5 — ioredis error listeners
dcd6e05 harden 1/5 — PA request timeout
59417d8 async health-monitor + uncaughtException + bounded shutdown drain
a5059cd #33 root cause — async exec in shell-skill
a50a8aa #36 periodic orphan reaper
ed45ee1 #34 pg-pool error handler
915d563 #32 Anthropic retry wrapper
f4db78a fleet versioning + heartbeat v0.2.0
```

### End-to-end channel framework now wired

For the first time the framework end-to-end composes without channel-
specific code:

```
skill output (approval_required)
  → TAG (bb93498) writes approval-request drawer
  → #40 outbound dispatcher (472d7f5) sends via channel MCP
  → [human taps button]
  → channel adapter writes inbox.messaging.<role> drawer
  → #39 inbound dispatcher (4fd76ee) fires subscribed skills
  → approval-resolver (fc70633) resolves the waitpoint
  → outbox entry → skill resumes via pillar pipeline
```

Two known gaps pending:
- **#45 Stage 1b** — `ai-skill.ts` (Phoenix's current executor path) doesn't
  emit to TAG. Until this bridge lands, Phoenix skills can't feed the
  pipeline without manual drawer writes.
- **#42** — concrete Telegram adapter refactor proving the pattern. First
  real-world validator of #38–#41.

### Dead-code removal

Commit `a547ac3` removed `orchestrator/` (pre-BullMQ scaffolding, zero
active consumers) and `workspaces/` (tenant registries that belong in
the consuming business's repo per CLAUDE.md). Nexmatic's consumer paths
tracked for migration in an issue on the Nexmatic repo.

## Phoenix Stabilization (2026-04-18)

**Completed today:**
- Trigger.dev fully removed — Docker images, volumes (11GB freed), services, code archived
- Worker stability: 7 bugs fixed (#18-#24 + health monitor deadlock + duplicate skill_runs)
- CLAUDE.md rewritten with Nexaas-only instructions + palace memory guidance
- Legacy artifacts archived to `~/.archive-legacy-2026-04-18/`
- `claude --print` skills converted to proper `ai-skill` type (tln-nightly-cruise, wp-daily)
- check-dispatch.sh written — bridges 68 YAML checks to run under Nexaas
- Duplicate BullMQ repeatables cleaned, all 21 skills re-registered cleanly
- `/nexaasify` slash command deployed for converting remaining YAML checks
- 15-command CLI fully operational

**Remaining Phoenix work:**
- 68 YAML checks to convert to proper Nexaas skills (via `/nexaasify`)
- `operations/memory/` flat-file state to migrate to palace drawers
- Notification channels to configure (TELEGRAM_BOT_TOKEN, RESEND_API_KEY)

---

## Strategic Sequence

```
Phase 1: Build Nexaas framework runtime        ✓ DONE
Phase 2: Prove Nexaas on Phoenix (own company) ✓ DONE (19/19 flows migrated)
Phase 2.5: Framework features + PA system      ✓ DONE
Phase 3: Launch Nexmatic on proven framework   ✓ DONE (21/21 items)
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
- [x] `cli/library.ts` — cross-workspace skill library (list, contribute, install, diff)

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

23. ~~**Implement `@nexmatic/auth`**~~ — ✓ DONE (NextAuth + operators + role-based access)
24. ~~**Wire auth into ops-console**~~ — ✓ DONE (email+password login, session checking, middleware)
25. ~~**Wire auth into client-dashboard**~~ — ✓ DONE (operator lookup, JWT sessions, 8h max)
26. ~~**Implement Nexmatic factory**~~ — ✓ DONE (`/new-skill`, `/new-flow`, `/new-mcp` moved to framework)
27. ~~**Implement `@nexmatic/library` infrastructure**~~ — ✓ DONE (`nexaas library` CLI — list, contribute, install, diff via palace)
28. ~~**Implement skill propagation**~~ — ✓ DONE (`nexaas propagate` CLI — check, push, accept, reject)
29. ~~**Implement library curation**~~ — ✓ DONE (`nexaas library promote/feedback`)
30. ~~**Implement ops notifications**~~ — ✓ DONE (unified dispatch: Telegram + Email/Resend + Palace, severity routing, dedup)
31. ~~**Implement closet compaction task**~~ — ✓ DONE (runtime background task, 5min cadence)
32. ~~**Implement waitpoint timeout reaper**~~ — ✓ DONE (runtime background task, 60s cadence)
33. ~~**Implement WAL signing**~~ — ✓ DONE (ed25519 in @nexaas/palace, operator keys, signed WAL entries)
34. ~~**Implement client dashboard extensions**~~ — ✓ DONE (WebAuthn passkeys, palace-backed settings API, WAL-audited config writes)
35. ~~**Implement Ops Console extensions**~~ — ✓ MOSTLY DONE (fleet view, skills/proposals/feedback UI exist; remaining: effective policy inspector, Factory Health metrics)
36. **`nexmatic-testlab` workspace** — conformance test suite, mock MCPs, test runner
37. **`nexmatic-ops` workspace** — dogfood with real Nexmatic internal automation
38. ~~**Implement backup strategy**~~ — ✓ DONE (`nexaas backup` CLI — run, list, test-restore, retention, backup_history tracking)
39. ~~**Implement GDPR**~~ — ✓ DONE (`nexaas gdpr` CLI — export, delete/cryptographic erasure, redact, subjects, audit trail)
40. ~~**Implement MCP scaffold**~~ — ✓ DONE (`nexaas create-mcp` + `/new-mcp` factory command)
41. ~~**Implement `nexaas dry-run`**~~ — ✓ DONE (manifest validation, MCP checks, prompt checks, shell --live execution)
42. ~~**Implement skill versioning runtime**~~ — ✓ DONE (version pinning, multi-version loading, version history tracking)
43. ~~**Implement framework upgrade mechanism**~~ — ✓ DONE (`nexaas upgrade` — git pull, npm install, migrations, worker restart, health verify)

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
│   ├── palace/src/                   IMPLEMENTED — palace API, WAL, embeddings, waitpoints, signing
│   ├── runtime/src/                  IMPLEMENTED — pipeline (CAG→RAG→Model→TAG→Engine),
│   │                                   model gateway, BullMQ worker, skill executors,
│   │                                   schema loader, fleet heartbeat, 4 background tasks
│   │                                   (compaction, waitpoint-reaper, notification-dispatcher,
│   │                                   inbound-dispatcher, approval-resolver, orphan-reaper,
│   │                                   health-monitor), retry/guardrail infrastructure
│   ├── cli/src/                      IMPLEMENTED — 15-command CLI (init, upgrade, status, health,
│   │                                   register-skill, trigger-skill, library, gdpr, verify-wal, etc.)
│   ├── factory/commands/             IMPLEMENTED — /new-skill, /new-flow, /new-mcp, /nexaasify
│   └── ops-console-core/src/         EMPTY — console widgets (consuming businesses build their own)
├── mcp/servers/palace/               Palace MCP server (8 tools)
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
