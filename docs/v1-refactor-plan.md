# Nexaas + Nexmatic v1 Refactor & Launch Plan

**Version:** Draft 2 (consolidated)
**Date:** 2026-04-15
**Status:** Ready for execution — all architectural questions answered and locked

---

## Executive Summary

This plan covers the parallel launch of **Nexaas v1** (the framework) and **Nexmatic v1** (the business built on it). They ship together but are architecturally and legally separate.

**Nexaas v1** is a targeted refactor on top of the existing `/opt/nexaas/` codebase. Approximately 60% of the current backbone (Ops Console shell, bootstrap, memory MCP, database schema, deploy scripts) is production-worthy and stays. The other 40% is either nuked scaffolding or rewritten to fit the pillar pipeline + palace architecture. v1 introduces the palace substrate, the pillar pipeline runtime, the capability system, the agent bundle format, sub-agent primitives, TAG Option C policy enforcement, the WAL hash chain with ed25519 operator signing, the model gateway with tier abstraction, the BullMQ-backed execution runtime with outbox pattern, and the factory authoring primitives.

**Nexmatic v1** is the business launch that uses the Nexaas v1 framework. Nexmatic v1 includes its own repository, its slash command implementations (`/new-flow`, `/new-skill`), its library of canonical skills (empty at launch, filled organically), its agent bundle scaffolds, its Ops Console extensions, its pricing model, and its first real clients.

The two ship together because you cannot launch Nexmatic without a working Nexaas, and Nexaas without a consuming business is unverifiable. But they live in separate repositories with separate licensing from Day 1 of Week 1.

**Target timeline: aspirational 5 weeks, realistic 10-12 weeks, no hard deadline.** The plan is sequenced by dependency, not by calendar pressure. Core runtime (palace + pipeline + BullMQ + TAG + model gateway) is the Week 1-2 priority. Factory + first client engagement follows. Supporting infrastructure (GDPR, backup, conformance suite, MCP scaffold) ships as it gets built — earlier is better but not blocking. Work continues until the v1-done thresholds in Part VII.9 are met.

---

## Part I: The Two-Repository Split

### Rationale

Nexaas is IP owned by Al personally (operating via Systemsaholic). Nexmatic is a commercial business that consumes Nexaas under a perpetual unconditional license. Phoenix Voyages and Systemsaholic operations also consume Nexaas under separate license grants. This ownership structure requires architectural separation: Nexaas code must live in Al's personal/Systemsaholic-owned repository, and Nexmatic's business code must live in Nexmatic's repository.

### Repository Structure

**`github.com/Systemsaholic/nexaas`** — the framework repository
- Owned by Systemsaholic
- LICENSE: proprietary with named grants (see `/opt/nexaas/LICENSE`)
- Monorepo with scoped packages:
  - `@nexaas/runtime` — pillar pipeline, sub-agent primitives, runTracker
  - `@nexaas/palace` — data model, palace API, WAL, signing, verification
  - `@nexaas/factory` — authoring primitives, slash command mechanism, library RAG
  - `@nexaas/ops-console-core` — console framework shell and widgets
  - `@nexaas/cli` — command-line tools (verify-wal, install-agent, validate-skill, rebuild-skill-runs)
- Framework documentation (`architecture.md`, `glossary.md`, developer reference)
- Deploy and provisioning scripts for a Nexaas runtime
- CI publishes to GitHub Packages under Systemsaholic org (private)
- Tag-based semver releases, starting at `0.1.0`

**`github.com/Systemsaholic/nexmatic`** — the business repository
- Owned by Nexmatic / Systemsaholic (TBD exact ownership — may shift if Nexmatic incorporates as a separate entity)
- Depends on `@nexaas/*` packages via npm
- Contains:
  - `skills/` — library of canonical Nexmatic skills
  - `agents/` — Nexmatic agent bundles
  - `mcp/servers/` — Nexmatic MCP server implementations
  - `factory/` — Nexmatic's `/new-skill` and `/new-flow` slash command implementations
  - `factory/archetypes/` — Nexmatic's pattern library
  - `ops-console/` — Nexmatic-branded Ops Console application
  - `client-dashboard/` — Nexmatic-branded client dashboard
  - `workspaces/` — client workspace manifests
  - `secrets/platform.env.enc` — sops-encrypted Tier 1 platform secrets
  - `scripts/` — Nexmatic-specific deployment and onboarding scripts
  - `docs/nexmatic.md` — business documentation

### Package Distribution

- **Registry**: GitHub Packages, under Systemsaholic organization, private
- **Auth**: each consumer organization (Nexmatic, Phoenix Voyages) has a read-only GitHub token configured in its `.npmrc` for pulling `@nexaas/*` packages
- **Semver**: Nexaas uses `0.x.y` during v1 (framework is under active evolution), moving to `1.x.y` once the framework stabilizes
- **Release workflow**: changesets for multi-package version management, tag-triggered publish

### Split Execution Plan (Week 1 Day 1)

1. **Create the Nexaas repo** at `github.com/Systemsaholic/nexaas`
2. **Audit the existing `/opt/nexaas/` codebase** and categorize every file as "framework", "business", "legacy", or "dead"
3. **Move framework files** into the new Nexaas repo with proper package structure (monorepo workspaces)
4. **Rename / recreate the existing repo as Nexmatic** containing only business-layer files
5. **Wire the dependency**: Nexmatic's `package.json` references `@nexaas/*` packages at version `0.1.0`
6. **Set up GitHub Packages** publishing in the Nexaas repo's CI
7. **Set up consumer authentication** in the Nexmatic repo's `.npmrc`
8. **First Nexaas release**: tag `v0.1.0`, CI publishes
9. **First Nexmatic install**: Nexmatic's npm install succeeds against the published packages
10. **Update import paths**: mechanical find-and-replace in Nexmatic to use `@nexaas/*` package paths instead of relative paths
11. **Verify existing builds still pass** on both sides
12. **Document the split** in both repos' READMEs

**Time estimate: 2-3 full days of focused work, likely spanning Monday-Wednesday of Week 1.**

### Development Workflow After Split

- Multi-root workspace setup on dev machines: both repos checked out side-by-side, opened in one editor window
- `npm link` for active cross-repo development: when editing a Nexaas package that Nexmatic consumes, link locally so changes are instant
- `scripts/dev-link.sh` and `scripts/dev-unlink.sh` in both repos automate the linking chain
- Commit discipline: Nexaas changes ship first, tag released, Nexmatic dependency version bumped, Nexmatic commits
- Changesets track all changes for changelog generation

### Migration for Existing Client VPSes

Existing client VPSes (envirotem, fairway, broken-stick-brewery) currently have the combined `/opt/nexaas/` structure. After the split, these VPSes need a migration:

- New directory structure: `/opt/nexaas/` for the framework runtime (installed via npm), `/opt/nexmatic/` for the business layer (Nexmatic library, workspace manifest, dashboard app)
- Migration script: `scripts/migrate-split.sh` that backs up the current `/opt/nexaas/`, installs the new layout, re-imports workspace state, and verifies health
- Migration executed after the new structure is stable and tested on a fresh install first

Fairway and BSBC contain only test/play data and can be wiped cleanly during migration. **Envirotem is excluded from v1 migration** — it has a live email→doc automation running in production and will be migrated separately once v1 is proven on other workspaces. Envirotem stays on its current Trigger.dev stack with the orphan-janitor band-aid until then.

---

## Part II: The Nexaas Framework Architecture (Summary)

Full architecture in `architecture.md`. Summary here for v1 plan context.

### Core Runtime

- **Pillar pipeline**: CAG → RAG → Model → TAG → engine, the fixed execution path for every skill step
- **Palace substrate**: per-workspace Postgres-backed memory store with drawers, rooms, closets, WAL
- **BullMQ execution**: sandboxed workers, transactional outbox for Postgres↔Redis atomicity, Bull Board observability
- **Model gateway**: provider-agnostic, tier-based selection (cheap/good/better/best), explicit fallback chains, Claude-primary
- **pgvector + Voyage-3**: per-VPS vector retrieval, replacing the legacy Qdrant approach
- **ed25519 signing**: per-workspace WAL hash chain, operator identity, Tier 1 file keys for bootstrap + Tier 2 WebAuthn for ops and clients

### Abstractions

- **Capabilities**: abstract integration interfaces, bound by workspace manifests to concrete MCPs, staged through Experimental → Converging → Stable lifecycle with conformance tests at Stable
- **Agents**: deployable bundles of skills with capability requirements, default contracts, and palace taxonomy
- **Skills**: atomic authored units with manifest, prompt, optional task.ts, palace footprint declaration
- **Flows**: client-specific compositions of skills, version-locked, editable via factory slash commands
- **Sub-agents**: L1 focused invocations (implemented), L2 agent-bundle specialists (composition), L3 persistent personas (schema reserved, runtime deferred)
- **Triggers**: cron, event, inbound-message, webhook, manual — plugin model
- **Channels**: role-based (not kind-based) for skill portability across workspaces

### Policy and Audit

- **TAG Option C**: layered policy with skill manifest defaults and behavioral contract overrides, every override audited
- **Contracts**: behavioral, data, skill — three kinds, with schema extensions for per-workspace customization
- **WAL**: hash-chained per workspace, tamper-evident via verification, ed25519-signed on privileged rows
- **Operator identity**: unified model for ops admins, ops members, and client admins; all sign their privileged actions

### Network Topology

- **Ops VPS**: runs operator console and library distribution, reachable via Tailscale only, does not run client workloads
- **Workspace VPSes**: one per client, each with own public IP, own Caddy TLS, own DNS subdomain, and optional self-service custom domains
- **Private LAN**: hub-and-spoke from ops VPS to each workspace, for ops traffic only (monitoring, deploys, library sync)

---

## Part III: Current Codebase Audit

### What Stays (real, production-worthy)

| Component | Why |
|---|---|
| `dashboard/` — Ops Console shell | 53 Next.js routes, real DB queries, shadcn UI, wired to `ops_health_snapshots` — becomes Nexmatic's Ops Console |
| `orchestrator/bootstrap/` — `createWorkspaceSession()` | Real, called by every task; extends to resolve capability bindings in Week 1 |
| `mcp/servers/memory/` — Memory MCP | 629 LOC, extended with palace API and pgvector instead of Qdrant, not rewritten |
| `database/migrations/` | 11 migrations define core schema; new migrations stack on top |
| `scripts/deploy-instance.sh` | Battle-tested, extended for Redis install, platform secrets push, pgvector setup |
| `scripts/provision-workspace.sh` | Small script, extended for new directory structure post-split |
| `scripts/health-*.sh` | Keep as-is |
| Core Trigger tasks: `run-agent`, `run-skill`, `sync-skills`, `heartbeat`, `collect-health`, `check-approvals` | Real, refactored to call pillar pipeline |
| `workspaces/*.workspace.json` | Format extended with capability bindings and channel bindings |
| Migration 008 — `integration_connections`, `pending_approvals`, `activity_log` | Real, becomes dashboard projections of palace data |
| `orchestrator/feedback/` | Real, integrates as TAG output sink |

### What Moves to Nexmatic Repo (business-layer, not framework)

| Component | Notes |
|---|---|
| `client-dashboard/` | Substantially built (copilot chat, TAG-aware gates, feedback, knowledge, billing via Stripe, NextAuthJS, TOTP). Reference implementation for the Nexmatic client dashboard — code is reusable, data is not. |
| `.claude/commands/` (12 existing slash commands) | Precursors to factory `/new-skill`, `/new-flow`. Inventory for reuse as factory seed material. |

### What Gets Nuked (zero regret)

All existing client data on all VPSes (including BSBC) is test/play data from pre-v1 experimentation. No data preservation required. Client VPSes will be wiped and re-provisioned cleanly during the v1 migration.

| Component | Reason |
|---|---|
| `orchestrator/promotion/` — *REVERSED: moved to rewrite* | Actually critical for library discipline, was prematurely marked for deletion |
| `orchestrator/sync/` — *REVERSED: moved to rewrite* | Actually critical for library propagation, was prematurely marked for deletion |
| `framework/engine/` | Python-based legacy engine, already marked retiring; systemd unit `engine.service` also removed |
| `agents/ops-monitor/` | Skeleton |
| `identity/`, `knowledge/`, `examples/` | Pre-v1 test content; clients start fresh with palace-backed content |
| `CLAUDE.ops.md` | Stale ops instructions; replaced by updated `CLAUDE.md` |
| Skill registry entries without `task.ts` | Never implemented, authoring pattern changes anyway |
| Unused MCP servers (legacy Plaid wiring with no call sites) | Re-add when actively used |
| Qdrant container on the ops VPS | Legacy from failed central-Qdrant era, replaced by per-VPS pgvector |
| `execute_weather_skill.js/ts` at repo root | One-off test artifacts |
| `deploy.sh` at repo root | Superseded by `scripts/deploy-instance.sh` |
| `better-sqlite3` dependency | Used only by Trigger.dev dev-mode cache; removed when Trigger.dev retires |
| Entire Trigger.dev Docker stack (webapp, postgres, redis, clickhouse, minio, electric) | Replaced by BullMQ + native Postgres + native Redis |
| All existing database data on all client VPSes | Test/play data from pre-v1; databases are dropped and re-created with clean v1 schema |
| `.trigger/` directory and Trigger.dev config | Dev-mode cache and lock files; no longer needed |

### What Gets Rewritten (sound concept, premature implementation)

| Component | What changes |
|---|---|
| `orchestrator/promotion/` | Build properly for library discipline, curation, proposal flow |
| `orchestrator/sync/` | Build properly for library propagation to client workspaces |
| Skills library | Moves to Nexmatic repo; authoring shape changes with palace + capabilities |
| Channel adapters (`deliver.ts` stub) | Becomes real — email, Telegram, dashboard, Slack, webhook adapters |
| Stub Trigger tasks (`diagnose-failure`, `receive-escalation`, `embed-event`, `migrate-legacy-memory`) | Re-implemented inside pillar pipeline |
| `nexaas-terminal.service` (WebSocket terminal on port 3002) | Moves to Nexmatic repo; remains the primary ops terminal for Claude Code sessions on client VPSes |
| Caddy config on client VPSes | Upgrade from minimal `:80` proxy to full TLS + custom domains + webhook routing |

### Existing Database — Clean Slate

Fairway and BSBC contain test/play data from pre-v1 experimentation. **No data migration needed for these.** Envirotem is excluded from v1 clean-slate — it stays on its current stack with a live automation until v1 is proven. During the v1 migration:

1. Drop all existing databases on client VPSes
2. Re-create fresh `nexaas` database with the v1 schema (migration `012_palace_substrate.sql` and all prior migrations applied cleanly from zero)
3. The ops VPS gets the same treatment — fresh database with the v1 schema

The existing 36 tables on BSBC (including `chat_messages`, `workspace_skills`, `token_usage`, `skill_versions`, etc.) were useful for prototyping and informed the v1 design but contain no data worth preserving.

### Existing Code Worth Referencing (not preserving data, but reusing patterns)

The following existing code is useful as **reference implementations** that inform v1 code, even though the data and specific implementations are discarded:

- **Client dashboard** (`client-dashboard/`) — the copilot chat for custom rules, TAG-aware approval gates, per-skill feedback/preferences/knowledge panels, Stripe billing, Plaid OAuth, NextAuthJS+TOTP auth are all patterns we reuse. The code moves to the Nexmatic repo and gets extended; the database it reads from starts fresh.
- **12 existing Claude Code slash commands** (`.claude/commands/`) — `add-agent`, `add-flow`, `onboard`, `deploy-skill`, `mcp-create`, etc. These inform the Nexmatic factory's `/new-skill` and `/new-flow` implementations.
- **`orchestrator/bootstrap/createWorkspaceSession()`** — real, tested, used by every Trigger task. Adapts to resolve capability bindings in v1.
- **`orchestrator/feedback/`** — real feedback capture pattern, integrates as TAG output sink in v1.
- **`mcp/servers/memory/`** — 629 LOC Memory MCP. Extends with palace API and pgvector; does not rewrite.

---

## Part IV: Palace Data Model

### Schema Extensions (Week 1 migration `012_palace_substrate.sql`)

Extend `nexaas_memory.events` with palace metadata:

```sql
ALTER TABLE nexaas_memory.events
  ADD COLUMN wing              text,
  ADD COLUMN hall              text,
  ADD COLUMN room              text,
  ADD COLUMN skill_id          text,
  ADD COLUMN run_id            uuid,
  ADD COLUMN step_id           text,
  ADD COLUMN sub_agent_id      text,
  ADD COLUMN dormant_signal    text,
  ADD COLUMN dormant_until     timestamptz,
  ADD COLUMN reminder_at       timestamptz,
  ADD COLUMN reminder_sent     boolean NOT NULL DEFAULT false,
  ADD COLUMN normalize_version int NOT NULL DEFAULT 1;

CREATE INDEX ix_events_palace ON nexaas_memory.events (workspace, wing, hall, room);
CREATE INDEX ix_events_dormant ON nexaas_memory.events (dormant_signal) WHERE dormant_signal IS NOT NULL;
CREATE INDEX ix_events_run ON nexaas_memory.events (run_id, step_id);
```

Closets for precomputed pointer index:

```sql
CREATE TABLE nexaas_memory.closets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace          text NOT NULL,
  wing               text,
  hall               text,
  room               text,
  topic              text NOT NULL,
  entities           text[],
  drawer_ids         uuid[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  normalize_version  int NOT NULL DEFAULT 1
);
```

Room compaction state for tracking closet staleness:

```sql
CREATE TABLE nexaas_memory.room_compaction_state (
  workspace                    text NOT NULL,
  wing                         text NOT NULL,
  hall                         text NOT NULL,
  room                         text NOT NULL,
  last_compacted_at            timestamptz NOT NULL DEFAULT '1970-01-01',
  last_compaction_duration_ms  int,
  last_drawers_compacted       int,
  last_error                   text,
  last_error_at                timestamptz,
  PRIMARY KEY (workspace, wing, hall, room)
);
```

Staleness telemetry for observability:

```sql
CREATE TABLE nexaas_memory.staleness_readings (
  id                   bigserial PRIMARY KEY,
  workspace            text NOT NULL,
  wing                 text NOT NULL,
  hall                 text NOT NULL,
  room                 text NOT NULL,
  cag_run_id           uuid,
  closets_read         int NOT NULL,
  live_tail_drawers    int NOT NULL,
  live_tail_age_ms     bigint NOT NULL,
  compaction_watermark timestamptz,
  read_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_staleness_room_time ON nexaas_memory.staleness_readings (workspace, wing, hall, room, read_at DESC);
```

WAL with hash chain + signing:

```sql
CREATE TABLE nexaas_memory.wal (
  id                  bigserial PRIMARY KEY,
  workspace           text NOT NULL,
  op                  text NOT NULL,
  actor               text NOT NULL,
  payload             jsonb NOT NULL,
  prev_hash           text NOT NULL,
  hash                text NOT NULL,
  signed_by_key_id    uuid REFERENCES nexaas_memory.operator_keys(id),
  signature           bytea,
  signed_content_hash text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ix_wal_workspace_hash ON nexaas_memory.wal (workspace, hash);
CREATE INDEX ix_wal_workspace_id ON nexaas_memory.wal (workspace, id);
```

Operator identity and keys:

```sql
CREATE TABLE nexaas_memory.operators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    text NOT NULL,
  email           text NOT NULL UNIQUE,
  role            text NOT NULL,          -- ops_admin | ops_member | client_admin
  workspace_scope text[],                 -- NULL = fleet-wide; specific = per-workspace
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at     timestamptz,
  notes           text
);

CREATE TABLE nexaas_memory.operator_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  public_key      bytea NOT NULL,
  algorithm       text NOT NULL DEFAULT 'ed25519',
  key_source      text NOT NULL,          -- file | webauthn | hsm
  credential_id   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  last_used_at    timestamptz
);

CREATE INDEX ix_operator_keys_active ON nexaas_memory.operator_keys (operator_id) WHERE retired_at IS NULL;
```

Embeddings (pgvector):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE nexaas_memory.embeddings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace     text NOT NULL,
  drawer_id     uuid NOT NULL REFERENCES nexaas_memory.events(id),
  wing          text,
  hall          text,
  room          text,
  embedding     vector(1024) NOT NULL,
  model         text NOT NULL DEFAULT 'voyage-3',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_embeddings_workspace_hnsw
  ON nexaas_memory.embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE workspace IS NOT NULL;

CREATE INDEX ix_embeddings_palace ON nexaas_memory.embeddings (workspace, wing, hall, room);
```

Skill runs (denormalized index):

```sql
CREATE TABLE nexaas_memory.skill_runs (
  run_id            uuid PRIMARY KEY,
  workspace         text NOT NULL,
  skill_id          text NOT NULL,
  agent_id          text,
  trigger_type      text NOT NULL,
  trigger_payload   jsonb,
  status            text NOT NULL,   -- running | waiting | completed | failed | escalated | cancelled
  current_step      text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_activity     timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  parent_run_id     uuid,
  depth             int NOT NULL DEFAULT 0,
  token_usage       jsonb,           -- { input_tokens, output_tokens, cost_usd }
  error_summary     text,
  metadata          jsonb
);

CREATE INDEX ix_runs_workspace_status ON nexaas_memory.skill_runs (workspace, status, last_activity DESC);
CREATE INDEX ix_runs_workspace_skill ON nexaas_memory.skill_runs (workspace, skill_id, started_at DESC);
CREATE INDEX ix_runs_parent ON nexaas_memory.skill_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
```

Outbox for transactional Postgres↔Redis:

```sql
CREATE TABLE nexaas_memory.outbox (
  id              bigserial PRIMARY KEY,
  workspace       text NOT NULL,
  intent_type     text NOT NULL,   -- enqueue_job | enqueue_delayed | cancel_job | etc.
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  error           text
);

CREATE INDEX ix_outbox_pending ON nexaas_memory.outbox (created_at) WHERE processed_at IS NULL;
```

Ops alerts (for the ops notification system):

```sql
CREATE TABLE nexaas_memory.ops_alerts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace             text NOT NULL,
  event_type            text NOT NULL,
  tier                  text NOT NULL,   -- page | inbox | digest | wal_only
  severity              text NOT NULL,   -- critical | high | medium | low
  payload               jsonb NOT NULL,
  fired_at              timestamptz NOT NULL DEFAULT now(),
  acknowledged_by       uuid REFERENCES nexaas_memory.operators(id),
  acknowledged_at       timestamptz,
  ack_signature         bytea,
  snoozed_until         timestamptz,
  resolved_at           timestamptz,
  resolution_type       text,            -- auto_cleared | ops_resolved | superseded
  recurring_count       int NOT NULL DEFAULT 1
);

CREATE INDEX ix_ops_alerts_active
  ON nexaas_memory.ops_alerts (workspace, event_type, fired_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX ix_ops_alerts_ack_window
  ON nexaas_memory.ops_alerts (workspace, event_type)
  WHERE acknowledged_at IS NOT NULL AND resolved_at IS NULL;
```

Client sessions (for NextAuthJS + session management):

```sql
CREATE TABLE nexaas_memory.client_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id      uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  workspace        text NOT NULL,
  auth_method      text NOT NULL,    -- oauth_google | oauth_microsoft | password_totp | magic_link
  device_label     text,
  ip_address       inet,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity    timestamptz NOT NULL DEFAULT now(),
  absolute_expires timestamptz NOT NULL,  -- 8h hard cap
  sliding_expires  timestamptz NOT NULL,  -- last_activity + 4h, rolling
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES nexaas_memory.operators(id),
  revoke_reason    text
);

CREATE INDEX ix_client_sessions_active
  ON nexaas_memory.client_sessions (operator_id, revoked_at)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_client_sessions_expiry
  ON nexaas_memory.client_sessions (sliding_expires)
  WHERE revoked_at IS NULL;
```

Operator recovery codes (for WebAuthn recovery):

```sql
CREATE TABLE nexaas_memory.operator_recovery_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  code_hash     text NOT NULL,    -- bcrypt or argon2 hash, never plaintext
  generated_at  timestamptz NOT NULL DEFAULT now(),
  used_at       timestamptz,
  used_ip       inet,
  UNIQUE (operator_id, code_hash)
);

CREATE INDEX ix_recovery_codes_operator
  ON nexaas_memory.operator_recovery_codes (operator_id, used_at);
```

Framework version tracking (for the upgrade mechanism):

```sql
CREATE TABLE nexaas_memory.framework_versions (
  id                  bigserial PRIMARY KEY,
  workspace           text NOT NULL,
  package_name        text NOT NULL,   -- @nexaas/runtime, @nexaas/palace, etc.
  version             text NOT NULL,
  installed_at        timestamptz NOT NULL DEFAULT now(),
  installed_by        uuid REFERENCES nexaas_memory.operators(id),
  install_signature   bytea,
  prior_version       text,
  snapshot_id         text,            -- reference to rollback snapshot
  smoke_test_result   jsonb,
  status              text NOT NULL    -- installing | active | rolled_back
);

CREATE INDEX ix_framework_versions_workspace
  ON nexaas_memory.framework_versions (workspace, package_name, installed_at DESC);
```

### Palace API (TypeScript)

```typescript
export interface PalaceContext {
  workspace: string
  runId?: string
  skillId?: string
  stepId?: string
  subAgentId?: string
}

export const palace = {
  enter(ctx: PalaceContext): PalaceSession,
}

export interface PalaceSession {
  writeDrawer(room: RoomPath, content: string, meta?: DrawerMeta): Promise<DrawerId>
  walkRoom(room: RoomPath, opts?: WalkOpts): Promise<Drawer[]>
  openClosets(wing?: string): Promise<Closet[]>
  createWaitpoint(args: {
    signal: string
    room: RoomPath
    state: Record<string, unknown>
    timeout?: string
    notify?: NotifyConfig
  }): Promise<WaitpointToken>
  wal(entry: WalEntry): Promise<void>
}

export async function resolveWaitpoint(
  signal: string,
  resolution: Record<string, unknown>,
  actor: string,
): Promise<{ runId: string, skillId: string, stepId: string }>
```

### Ontology

Per-workspace wings follow a canonical ontology maintained in the Nexaas repo at `palace/ontology.yaml`. Initial wings:

- `inbox.*` — incoming messages and events awaiting processing
- `events.*` — domain events for triggering and audit
- `knowledge.*` — static or slow-changing reference material
- `accounting.*`, `marketing.*`, `operations.*`, `onboarding.*` — domain-specific business data
- `notifications.*` — pending outbound notifications
- `ops.*` — ops-visible state (escalations, errors, audits, health, telemetry, integrations)
- `personas.*` — reserved for L3 sub-agents in a future version

Adding a new top-level wing requires a PR against the ontology file. Halls and rooms can be added by skill manifests that declare them against registered patterns.

---

## Part V: TAG Option C Policy

Implementation in `@nexaas/runtime/tag/route.ts`:

```typescript
export async function route(params: {
  output: ClaudeOutput,
  skillId: string,
  workspace: string,
}): Promise<TagRouting> {
  const manifest = await loadSkillManifest(params.skillId)
  const contract = await loadBehavioralContract(params.workspace)

  const actions: RoutedAction[] = []

  for (const action of params.output.actions) {
    const manifestRule = manifest.outputs.find(o => o.id === action.kind)
    if (!manifestRule) {
      actions.push({ action, routing: 'escalate', source: 'tag-unknown-action' })
      continue
    }

    const defaultRouting = manifestRule.routing_default
    const override = contract.skill_overrides?.find(o =>
      o.skill === params.skillId && o.output === action.kind
    )

    if (!override) {
      actions.push({ action, routing: defaultRouting, source: 'manifest-default' })
      continue
    }

    if (!manifestRule.overridable) {
      await palace.wal({
        workspace: params.workspace,
        op: 'tag_override_denied',
        actor: 'tag',
        payload: { skill: params.skillId, output: action.kind, attempted: override.routing }
      })
      actions.push({
        action,
        routing: defaultRouting,
        source: 'manifest-locked',
        override_denied: override,
      })
      continue
    }

    if (!manifestRule.overridable_to?.includes(override.routing)) {
      actions.push({
        action,
        routing: defaultRouting,
        source: 'override-out-of-envelope',
        override_denied: override,
      })
      continue
    }

    actions.push({
      action,
      routing: override.routing,
      source: 'contract-override',
      authorized_by: override.authorized_by,
      authorized_at: override.authorized_at,
      reason: override.reason,
    })
  }

  return { actions, skillId: params.skillId, workspace: params.workspace }
}
```

Every override (accepted or denied) writes to the WAL. The Ops Console gets an **Effective Policy** view per workspace × skill.

---

## Part VI: Model Gateway

### Model Registry

Located at `capabilities/model-registry.yaml` (framework-provided, tier aliases; specific model choices are Nexmatic-customizable):

```yaml
version: 2.0

providers:
  anthropic:
    kind: remote-api
    auth_env: ANTHROPIC_API_KEY
    client: "@anthropic-ai/sdk"
    status: primary

  openai:
    kind: remote-api
    auth_env: OPENAI_API_KEY
    client: "openai"
    status: fallback

  self-hosted-local:
    kind: openai-compatible
    base_url: http://10.10.0.20:8100
    auth_env: NEXAAS_LLM_TOKEN
    status: experimental

tiers:
  cheap:
    primary: { provider: anthropic, model: claude-haiku-4-5-20251001, context_window: 200000, input_cost_per_m: 1.00, output_cost_per_m: 5.00 }
    fallbacks:
      - { provider: openai, model: gpt-4o-mini, context_window: 128000 }
  good:
    primary: { provider: anthropic, model: claude-sonnet-4-6, context_window: 200000, input_cost_per_m: 3.00, output_cost_per_m: 15.00 }
    fallbacks:
      - { provider: openai, model: gpt-4o }
  better:
    primary: { provider: anthropic, model: claude-sonnet-4-6, extended_thinking: true }
    fallbacks:
      - { provider: anthropic, model: claude-opus-4-6 }
      - { provider: openai, model: gpt-4o }
  best:
    primary: { provider: anthropic, model: claude-opus-4-6, input_cost_per_m: 15.00, output_cost_per_m: 75.00 }
    fallbacks:
      - { provider: anthropic, model: claude-opus-4-6, context_window: 1000000 }
      - { provider: openai, model: gpt-4o }
```

### Gateway Behavior

```typescript
export async function execute(params: {
  tier: ModelTier,
  messages: Message[],
  system?: string,
  tools?: Tool[],
  workspaceId: string,
  runId: string,
  stepId: string,
}): Promise<ExecuteResult>
```

1. Resolve tier in registry
2. Apply workspace contract model policies (caps, allowed/blocked providers, cost limits)
3. Check context window fit
4. Check workspace cost cap (internal margin protection)
5. Attempt primary with 3-retry exponential backoff
6. On retryable failure, walk fallback chain, log each attempt to WAL
7. Normalize tool-use format across providers (Anthropic, OpenAI, OpenAI-compatible)
8. Record actual token usage + cost
9. When falling back from Claude on `best` tier, auto-elevate routing to `approval_required`
10. Return normalized result

### Cost Cap — Nexmatic Internal Margin Protection

Cost caps are enforced per workspace as Nexmatic-internal controls, not as client-facing limits. When a workspace approaches its cap, ops is alerted. The client dashboard does NOT show cost caps in dollars — it shows usage in client-meaningful units (skill runs, approvals) mapped to their plan.

---

## Part VII: BullMQ Execution Runtime

### Architecture

```
Skill code
  ↓
Pillar pipeline (CAG → RAG → Claude → TAG → engine actions)
  ↓
Nexaas runtime (runSkillStep, subagent invocation, waitpoint management)
  ↓
BullMQ Flows + sandboxed workers
  ↓
Redis + Postgres
```

### Transactional Outbox

Cross-store atomicity (Postgres `skill_runs` + Redis queue) via outbox pattern:

1. Step completes, runtime opens a Postgres transaction
2. Update `skill_runs.status`, `skill_runs.current_step`, `skill_runs.token_usage`
3. Insert outbox row with `intent_type: enqueue_job` and payload describing the next step
4. Commit transaction
5. Outbox relay process (separate systemd service) polls for unprocessed outbox rows
6. For each row: enqueue the corresponding BullMQ job, mark outbox row processed
7. If relay crashes, unprocessed rows remain; next relay startup resumes them

This gives exactly-once semantics for the state transition and at-least-once semantics for the enqueue (with BullMQ dedup handling the at-least-once side).

### Sandboxed Processors

BullMQ workers run in sandboxed child processes. Each job runs in its own subprocess with a clean cgroup inheritance from the parent. Worker crashes kill the child, not the parent. No `setsid`, no reparenting to PID 1, no orphan accumulation. This structurally prevents the failure mode that affected Phoenix's Trigger.dev deployment.

### Per-Workspace Concurrency

BullMQ concurrency is configured per-key with the workspace as the key, preventing one client's runaway skill from starving others on the same VPS. Since workspaces run on their own VPSes, this is defensive — but useful if multiple skills on the same workspace contend for resources.

### Bull Board

Embedded in the Nexmatic Ops Console at `/ops/queues/<workspace-id>`. Provides per-workspace queue visibility, retry tooling, failure inspection. This is production-grade job observability out of the box, no custom dashboard build required.

---

## Part VII.5: Client Dashboard Auth

Session authentication for client admins uses **NextAuthJS** with multiple provider options. Privileged action signing uses **WebAuthn** per-action gestures, independent of session auth. The two concerns are decoupled: session auth gets you into the dashboard; WebAuthn signing proves you authorized a specific action.

### Session Auth Options

- **OAuth providers**: Google, Microsoft 365 (primary); GitHub, Apple (secondary as client demand dictates)
- **Email + password + TOTP 2FA**: fallback for clients without supported OAuth providers; TOTP is required, not optional
- **Magic link**: optional alternative for clients preferring email-code-based auth

NextAuthJS handles all three via its adapter pattern. Configuration lives in the Nexmatic client dashboard application.

### Session Duration

- **4-hour sliding window** on inactivity
- **8-hour absolute cap** from initial login
- **2-hour silent re-auth threshold**: if a session is older than 2 hours when the client attempts a privileged action, the client is asked to re-authenticate (via their original provider) before the WebAuthn gesture

These are defaults. Workspace behavioral contracts can override for high-security clients (e.g., 2h/4h/1h for a regulated-industry client).

### Multi-Device Sessions

- Maximum 3 concurrent active sessions per client admin
- Exceeding the limit silently invalidates the oldest session
- "Active Sessions" view in the client dashboard shows device, IP, and activity timestamps with one-tap revocation
- Ops-initiated session revocation is a signed operator action

### Passkey Recovery

Recovery via 10 one-time codes, generated at enrollment, hashed on storage:

- Format: `xxxx-xxxx-xxxx` (12 alphanumeric characters, grouped for readability)
- Generated at enrollment, client saves them somewhere secure (password manager, printed copy)
- Regeneratable: client can generate a new set anytime, invalidating old codes
- Nagged to regenerate when 50% have been used
- Recovery flow: client provides email + one-time code → email verification → ops review window (4 hours, can intervene) → new passkey enrollment

### Out-of-Band Ops Recovery

If a client loses everything (passkey, recovery codes, email access), ops can initiate re-enrollment via the Ops Console after verifying identity through another channel (phone, video, in-person). This is a signed operator action with the reason documented.

### Enrollment Security

- One-time enrollment tokens signed by ops, expire in 24 hours, single-use
- Email confirmation required during enrollment
- New operator enrollment writes a WAL drawer signed by the authorizing ops member
- Ops receives a Tier B alert (per the ops notification system) on every new operator enrollment for audit

### Required Tier 1 Platform Secrets for Auth

Add to the sops-encrypted platform secrets:
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_SECRET` — Google OAuth provider
- `M365_OAUTH_CLIENT_ID`, `M365_OAUTH_SECRET` — Microsoft 365 OAuth provider
- `NEXTAUTH_SECRET` — NextAuthJS session signing secret
- Additional OAuth providers as client demand dictates

### Week 3 Build Items

- NextAuthJS integration in the Nexmatic client dashboard
- OAuth provider setup and app registration for Google + Microsoft 365
- TOTP fallback flow with Google Authenticator / Authy support
- Magic link flow
- Passkey enrollment during first-login
- Recovery code generation and validation
- Session management with sliding + absolute expiry
- Active sessions view with revocation
- Ops Console support for ops-initiated session revocation
- Ops Console support for ops-initiated recovery authorization

---

## Part VII.6: Ops Notifications

The framework provides **ops channel roles** as a registered concept. Nexmatic configures which channels fulfill each role, with Nexmatic-specific routing policy.

### Framework-Provided Channel Roles

- `ops_page` — Tier A, immediate attention required
- `ops_inbox` — Tier B, within-the-hour attention
- `ops_digest` — Tier C, daily rollup
- `ops_audit` — Tier D, WAL-only, no active notification

### Nexmatic's Channel Bindings

Nexmatic's ops notification policy lives in `nexmatic/ops-notifications/policy.yaml`:

```yaml
channel_bindings:
  ops_page:
    primary:
      kind: slack
      mcp: slack
      config:
        channel: "#nexmatic-ops-page"
        thread_per_event: true
        inline_actions: [acknowledge, snooze_1h, link_console]
    fallback:
      kind: email-outbound
      mcp: resend
      config:
        to: ops-oncall@nexmatic.ca
        subject_prefix: "[PAGE]"

  ops_inbox:
    kind: slack
    mcp: slack
    config:
      channel: "#nexmatic-ops-inbox"
      batch_window_seconds: 300

  ops_digest:
    kind: email-outbound
    mcp: resend
    config:
      to: ops-team@nexmatic.ca
      delivery_time: "08:00 EST"

  ops_audit:
    kind: wal-only

ack_window_default: 15m
snooze_duration: 1h
recurring_threshold:
  count: 4
  window: 24h
  escalation: ops_page_recurring
```

### Tier Mapping (Nexmatic Default)

- **Tier A (page)**: workspace unreachable, WAL verification failed, WAL signature invalid, critical skill crash, cost cap exceeded
- **Tier B (inbox)**: TAG escalate-to-ops, waitpoint timeout escalate, staleness choked sustained, integration auth expired, integration API errors sustained, closet compaction failing
- **Tier C (digest)**: model fallback to non-Claude, cost cap approaching 80%, library contribution pending curation, routine approvals volume summary
- **Tier D (WAL-only)**: skill run success, routine OAuth refresh, operator signin

### Acknowledgment and Snooze

Tier A notifications include three inline Slack buttons:
- **Acknowledge**: silences re-alerts on the same `(workspace, event_type)` pair for 15 minutes
- **Snooze 1 hour**: silences for 60 minutes
- **Link to Ops Console**: opens the relevant drill-down page

Acks are signed operator actions written to the WAL. Repeated unresolved acks (4+ in 24 hours) auto-escalate to a "recurring issue" alert that requires full resolution.

### Rate Limiting

- Per `(workspace, event_type)`: max 1 alert per 5 minutes, counter shown in next alert
- Per workspace: 10 pages per hour, exceeding triggers "WORKSPACE IN CRISIS" supersession
- Per fleet: 20 pages per hour fleet-wide, exceeding triggers "FLEET EVENT" supersession

### Week 3 Build Items

- Ops channel role registry in `@nexaas/runtime`
- Slack MCP server in Nexmatic repo
- Email-outbound MCP (Resend) in Nexmatic repo
- Ops notification dispatch service (background task reading from `ops_alerts` and fanning to channels)
- Rate limiter
- Acknowledgment handler with per-action signing
- Recurring-issue auto-escalation detector
- Ops Console view: Active Alerts, Acknowledged, Snoozed, Resolved

---

## Part VII.7: Skill Versioning and In-Flight Drain

Nexmatic's library uses semver with different propagation rules per version level.

### Version Level Semantics

- **Patch (`v1.2.3 → v1.2.4`)**: strictly bug fixes, no behavior change. Propagates **immediately** to all subscribed workspaces. In-flight runs pick up the patched code on their next step.
- **Minor (`v1.2 → v1.3`)**: new features, backward-compatible. Propagates to workspaces; new runs use the new version; **in-flight runs continue on their original minor version** until completion. Multi-version runtime keeps both loaded.
- **Major (`v1.x → v2.0`)**: breaking changes. Requires explicit ops approval, in-flight run drain, and signed upgrade action.

### Run Version Pinning

The `skill_runs` table records the exact version a run started on:

```sql
ALTER TABLE nexaas_memory.skill_runs
  ADD COLUMN skill_version text;
```

At run start, the runtime resolves the current version of the skill and pins it. Every subsequent step (including resumes from waitpoints) executes the pinned version.

### Multi-Version Loading

For minor version upgrades, the runtime can load multiple versions of the same skill simultaneously. Typical state: current version + any prior minor version still referenced by in-flight runs.

Skill files live in versioned subdirectories:

```
skills/accounting/transaction-matching/
├── v1.2/
│   ├── skill.yaml
│   ├── prompt.md
│   └── task.ts
├── v1.3/
│   ├── skill.yaml
│   ├── prompt.md
│   └── task.ts
```

The runtime resolves the version from `skill_runs.skill_version` and imports from the matching directory.

### Deprecation Window

Older minor versions are eligible for garbage collection **30 days** after the last run referencing them completes. Before deletion:
1. Runtime checks for any in-flight runs on the version
2. If none, version is removed and disk space reclaimed
3. If any remain, ops is alerted ("workspace X has a v1.2 run blocking deprecation")
4. Ops decides: wait, force-drain, or extend window

Force-drain is **per-run approved**, not bulk. Ops reviews each stuck run individually and signs the drain decision.

### Major Version Upgrade Flow

1. Nexmatic publishes `v2.0` of a skill
2. Propagation pipeline creates a **proposal** for each subscribed workspace
3. Ops sees the proposal in the Ops Console with a count of in-flight runs on `v1.x`
4. Ops chooses: wait for natural drain, force-drain, or defer workspace
5. When the workspace is ready, ops signs the upgrade and the new version is applied
6. No in-flight run ever executes on `v2.0` — they complete on their original version first

### MCP Interface Version Matching

Skills at different versions may depend on different MCP interface versions. MCPs implement **multiple interface versions simultaneously** per the capability maturity design, so `bank-source` can provide both `v1.0` and `v1.1` on the same workspace. Skills route to their pinned interface version.

When an MCP drops an old interface version after its deprecation window, any skill still depending on it fails to load, and ops sees the failure via ops notification.

### Week 2 Build Items

- Version resolution at run start (`skill_runs.skill_version`)
- Multi-version skill loader
- Minor version propagation with in-flight preservation
- Major version proposal flow with per-workspace approval
- Deprecation window garbage collection
- Per-run force-drain workflow
- Ops Console views: in-flight runs by version, upgrade proposal queue, version deprecation status

---

## Part VII.8: Runtime Upgrade Mechanism

Framework version upgrades are orchestrated from the Ops Console, with a two-tier canary (test-and-proving + dogfood) before reaching client workspaces.

### Five-Layer Validation Gate

1. **Unit + integration tests** in the Nexaas CI pipeline — must pass before publish to GitHub Packages
2. **Conformance suite on `nexmatic-testlab`** — runs a structured test suite against the new version; must pass before ops approval
3. **Dogfood soak on `nexmatic-ops`** — 24-48 hour soak under Nexmatic's internal automation; monitored
4. **Canary client rollout** — clients who've opted into canary status; 24-hour soak each
5. **Fleet rollout** — remaining clients in batches, scheduled per workspace timezone

### `nexmatic-testlab` — Test and Proving Workspace

A dedicated Nexaas workspace owned by Nexmatic, existing exclusively for framework validation. Contains:

- Pre-built skills exercising every framework invariant (pillar pipeline, TAG routing, waitpoints, sub-agents, capability binding, model gateway fallback, WAL signing, palace queries, closet compaction, staleness escalation)
- Mock MCPs with deliberate failure modes (rate-limit simulation, slow-response, invalid schema, auth errors)
- A synthetic client dashboard with automated approval flows
- A seeded palace with known-state drawers for retrieval consistency testing
- A `test-runner/` that orchestrates all tests and compares against baseline snapshots

Every new framework version runs the full conformance suite on `nexmatic-testlab` before ops can approve for rollout. Test failures block the version.

### `nexmatic-ops` — Dogfood Workspace

A workspace running Nexmatic's real internal automation: fleet health reports, cost summaries, library audits, factory usage statistics, weekly release note summaries to stakeholders. This is real work, not synthetic.

After `testlab` passes, the new version is installed on `nexmatic-ops` and soaks for 24-48 hours under real usage. If Nexmatic's own internal work continues normally, the version is cleared for client rollout.

### Per-Workspace Upgrade Flow

For each target workspace:

1. **Lock out new runs** — runtime refuses new skill runs; waitpoint resolutions queue
2. **Drain in-flight runs** — wait for current steps to complete (10-minute timeout)
3. **Force-drain decision** — if runs remain, ops is prompted per-run
4. **Snapshot** — Postgres backup, Redis RDB snapshot, filesystem state preserved
5. **Stop services** — systemctl stops all Nexaas services
6. **Install new version** — `npm install @nexaas/runtime@newversion @nexaas/palace@newversion ...`
7. **Apply schema migrations** — new migration files run against Postgres
8. **Start services** — systemctl starts services in dependency order
9. **Smoke tests** — `verify-wal`, capability health check, pipeline smoke test
10. **Unlock** — accept new runs, process queued waitpoint resolutions
11. **WAL entry** — signed `framework_upgraded` drawer with old/new versions, duration, test results

### After-Hours Scheduling

Framework upgrades are scheduled during each workspace's local 2-4 AM window (read from workspace manifest timezone). This avoids surprising clients with maintenance during their business hours.

Ops can override the schedule for specific workspaces (e.g., emergency patch rollout, client-requested window).

### Rollback

Snapshots are retained for **7 days** post-upgrade. If a rolled-out version shows problems within that window, ops invokes `rollback-workspace.sh <workspace-id> <snapshot-id>` which restores:
- Postgres from dump
- Redis from RDB snapshot
- Filesystem state of `/opt/nexaas/` and `/opt/nexmatic/`

After 7 days, snapshots are deleted; recovery falls back to regular backups (backup strategy is batch 4 deferred work).

### Schema Migration Rules

- Framework migrations ship in `@nexaas/palace` as numbered SQL files
- Each migration must be backward-compatible with the version immediately prior
- Dropping columns or tables is deferred one version past their replacement
- Every migration has a rollback script
- Major-version migrations may break backward compatibility but require explicit ops opt-in during approval

### Week 2-3 Build Items

- `scripts/upgrade-workspace.sh` — orchestrated upgrade script (Week 2)
- `scripts/rollback-workspace.sh` — rollback script (Week 2)
- Snapshot mechanism (Postgres + Redis + filesystem) (Week 2)
- Smoke test scripts: `verify-wal`, `capability-health`, `pipeline-smoke-test` (Week 2)
- Schema migration framework with version tracking and rollback (Week 2)
- Conformance test suite for `nexmatic-testlab` (Week 2, parallel with runtime features)
- `nexmatic-testlab` workspace provisioning (Week 2)
- `nexmatic-ops` workspace provisioning with real Nexmatic automation (Week 3)
- Ops Console "Framework Updates" view (Week 3)
- Ops Console per-workspace upgrade orchestration UI (Week 3)
- Fleet view showing current versions per workspace (Week 3)
- Signed `framework_upgrade_approval` and `framework_upgraded` WAL op types (Week 2)

---

## Part VII.9: Factory Success Metrics

The factory is the architectural enforcement mechanism for Nexaas framework invariants. Every skill that bypasses the factory is a risk of drift from the pillar pipeline shape, capability abstraction, TAG routing hygiene, WAL + signing discipline, or palace footprint declaration. Target: **100% factory usage** during v1. Any bypass is investigated as either a factory gap or a framework violation.

### Measurement Dimensions

**Factory health** (does the authoring machinery work?)
- Factory usage rate — target 100%
- Factory completion rate — target >80%
- Median time from interview start to validated skill — target <30 min simple, <2 h complex
- Validation pass rate on first attempt — target >70%

**Library health** (is the library accumulating useful work?)
- Library contribution rate — target >90%
- Canonical promotion rate within 30 days — target >50%
- Library size growth by archetype — measured, no specific target
- Average genealogy depth (references to prior library work) — target >40%

**Cross-pollination** (is the library getting faster?)
- Time-to-first-skill comparison (client N vs client N-1) — target: client 3 takes <70% of client 1's time
- Reuse event count — target: >50% of factory sessions surface prior library, >30% of surfaced items reused
- Proposal flow events — target: ≥1 proposal accepted during Week 3-4 soak

**Signing and audit health**
- Signature rate on privileged actions — target 100%
- WAL verification pass rate — target 100%
- Client admin signature latency (median) — target <4 h during business hours
- Ops alert ack rate — target >80% ack, <20% snooze

**Fleet health**
- Workspace uptime — target >99%
- Skill run success rate — target >95%
- Model fallback rate — target <5% during normal operation
- Staleness distribution — target >90% Healthy, <5% Choked

### Required Thresholds for v1 Declared Done

- Factory usage: **100%** (factory-as-enforcement)
- Privileged action signing: 100%
- WAL verification: 100% pass
- Workspace uptime: >99%
- Skill run success: >90%
- At least 1 cross-pollination event
- At least 1 accepted improvement proposal
- Factory completion rate: >70%
- No unanswered Tier A alerts >1 hour

### Factory Health View

Ops Console renders all metrics in a single "Factory Health" view materialized from palace queries, `skill_runs`, WAL, `ops_alerts`, and `staleness_readings`. At end of Week 4, this view is the v1 success report.

### Week 4 Soak

The soak isn't just "run things" — it's specifically:
- Watch the Factory Health view every morning
- Investigate any red boxes the same day
- Collect specific operator feedback after each factory session
- Ship fixes within 24 hours when something is visibly broken
- Tune compaction cadences, staleness thresholds, alert policies based on real data
- Daily state-of-the-fleet review

### v1-Done Call

**Ops team** (initially Al alone) reviews the Factory Health view and makes the call, with documented pilot client feedback folded in.

---

## Part VIII: The Factory

Factory primitives live in `@nexaas/factory`. Nexmatic's specific slash commands (`/new-skill`, `/new-flow`) live in the Nexmatic repo and use these primitives.

### Framework Primitives

- Slash command registration mechanism for Claude Code
- Authoring interview state machine (abstract, schema-driven)
- Library palace for RAG retrieval over canonical skills and flows
- Archetype template loader and instantiator
- Skill manifest generator and validator
- Library contribution pipeline (push to library, genealogy tracking, experimental stage marking)
- Proposal flow for propagating updates to running workspaces

### Nexmatic Implementation

Nexmatic's `/new-flow` and `/new-skill` implementations:

- Walk operators through Nexmatic's authoring interview (intake + 14 authoring questions)
- Query Nexmatic's library via RAG in Phase 0
- Stamp from Nexmatic's archetype pattern library
- Generate Nexmatic-branded skill manifests
- Push contributions back to Nexmatic's library
- Handle per-client customizations via workspace schema extensions, not canonical skill changes

### The Factory as a Skill

`/new-skill` is itself a skill in Nexmatic's library. It has a manifest, reads from `knowledge.nexmatic.patterns`, writes back its learnings, and improves via the same SKILL_IMPROVEMENT_CANDIDATE pipeline. The factory improves itself.

---

## Part IX: Build Sequence

### Week 1 — Split + Substrate

**Day 1: Repo split**
- Create Nexaas repo, audit current codebase, move framework files
- Create Nexmatic repo (or rename existing), move business files
- Set up GitHub Packages publishing
- First Nexaas release `v0.1.0`, first Nexmatic install
- Update import paths, verify builds
- Draft LICENSE file (done), README files

**Day 2-3: Palace substrate migration**
- Migration `012_palace_substrate.sql`: palace extensions, closets, wal, operator tables, pgvector embeddings, skill_runs, outbox
- Retire the legacy nexmatic-central Qdrant container
- `@nexaas/palace` package: TypeScript API
- Platform secrets sops setup, `deploy-instance.sh` extension for platform secrets push
- Redis install added to `deploy-instance.sh`

**Day 4-5: Capability + trigger + channel scaffolding**
- Capability registry format and Stage 1 entries for the 10 initial capabilities
- Trigger type registry (cron, event, webhook, inbound-message, manual)
- Channel role registry in workspace manifest format
- HTTP endpoint `POST /api/v1/waitpoints/:signal/resolve`
- HTTP endpoint `POST /api/v1/webhooks/:path` for webhook triggers

**Day 5-7: Nuke + ops hygiene**
- Delete legacy scaffolding (`orchestrator/promotion/` and `orchestrator/sync/` stay — move to rewrite)
- Delete dead skill registry entries, dead MCP configs, client-dashboard stub, framework/engine
- Deploy orphan-janitor systemd timer to existing client VPSes (leftover Trigger.dev orphan prevention)
- Add migration for existing VPSes from combined structure to split structure (nexmatic repo deploy)

### Week 2 — Runtime + Model Gateway

**Day 1-2: Pillar pipeline runtime**
- `@nexaas/runtime`: `runSkillStep.ts` with the CAG → RAG → model → TAG → engine flow
- CAG assembly walking palace + behavioral contract
- RAG retrieval via pgvector + Voyage-3
- TAG Option C route function
- Engine apply for each routing outcome
- Sub-agent L1 primitive (`runtime.subagent()`)

**Day 3: Model gateway**
- Model registry loader
- Provider implementations: Anthropic (first), OpenAI (second), OpenAI-compatible stub
- Tool-use format normalization
- Fallback chain walking with WAL logging
- Cost estimation and tracking
- Workspace contract cap enforcement
- Auto-elevation of `best`-tier non-Claude fallbacks

**Day 4: BullMQ integration**
- Runtime wraps skill step invocation as BullMQ jobs
- Outbox relay service (systemd unit)
- Sandboxed worker configuration
- Bull Board mounting point for Ops Console
- Per-workspace concurrency keys

**Day 5: WAL + operator signing**
- Hash chain WAL insert library with lock+retry
- ed25519 signing library for privileged rows
- Operator identity table + registry lookup
- Tier 1 file-based key for bootstrap operator
- `verify-wal` CLI with incremental + full-chain modes
- WebAuthn enrollment primitives in `@nexaas/ops-console-core`

**Day 6-7: Closet compaction + waitpoint reaper**
- Closet compaction background task (default 5min business / 30min off-hours)
- Staleness telemetry per CAG read
- Three-tier health status (Healthy, Drifting, Choked) with TAG escalation on sustained Choked
- Waitpoint timeout reaper task (60-second cadence)
- Timeout policy enforcement: escalate default, auto_approve/reject/cancel per manifest
- Reminder sending via configurable channel role
- `runTracker.ts` library for library-enforced status transitions

### Week 3 — Nexmatic Factory + First Real Client

**Day 1-2: Nexmatic factory implementation**
- `/new-flow` slash command in Nexmatic repo
- `/new-skill` slash command in Nexmatic repo
- Nexmatic authoring interview questions
- Nexmatic's first 2 archetype templates (to be filled out as clients arrive)
- Library RAG over Nexmatic's canonical skills (empty at this point)
- Contribution pipeline to Nexmatic's library

**Day 3-4: First real client engagement**
- Whatever real client is ready, whatever their first flow is
- Authored via the factory, not hand-coded
- Deployed to their workspace
- Observability via Ops Console
- Result: first skill in Nexmatic's library, first cross-workspace experience

**Day 5-7: Iterate, second client if available**
- Refine factory based on first experience
- If second client ready: second flow via factory, exercising library RAG for potential reuse
- Contribution tracking and library hygiene in motion

### Week 4 — Third Flow + Fleet Observability + Soak

**Day 1-2: Third real client or third flow for existing client**
- If new archetype, add to pattern library
- If reuses existing archetype, cross-pollination proven

**Day 3-4: Ops Console fleet features**
- Fleet status overview across workspaces
- Active runs view
- Pending approvals aggregated
- Recent failures
- Effective policy inspector per workspace × skill
- WAL audit view with chain verification status
- Library inbox for new contributions

**Day 5-7: Soak**
- Monitor all active flows on all pilot workspaces
- Respond to issues, tune compaction cadences, adjust staleness thresholds
- Gather real production data on usage, costs, fallback events, approval latencies
- Engage clients on their experience, collect refinement feedback

### Week 5 — Buffer

- Fix whatever broke in Week 4
- Formal post-mortem across pilot clients
- First pass at factory automation refinements based on real operator experience
- Freeze Nexaas `v1.0.0` and Nexmatic `v1.0.0`, tag and release
- Document lessons, update plan for v1.1

---

## Part IX.5: Backup, GDPR, Testing, MCP Development, Client Dashboard

### Backup Strategy

- **Dedicated OVH backup project** (separate IAM from main Nexmatic infra)
- **Per-workspace buckets** inside the backup project (`nexmatic-backup-<workspace-id>`)
- **Per-VPS upload directly** to its own bucket; credentials stored only on that VPS
- **Daily backups** at 2 AM local time: `pg_dump` + Redis RDB + filesystem tar + SHA256 manifest
- **Bi-weekly restore-tests** that verify backups are actually restorable (not just that files exist)
- **Retention**: 30 days daily, 12 weeks weekly, 12 months monthly, 7 years annual; overridable per workspace contract
- **Recovery** is a signed operator action via `scripts/recover-workspace.sh`
- **Backup health** surfaced in Ops Console per workspace and fleet-wide
- **Daily backup failure → Tier B alert; bi-weekly restore-test failure → Tier A page**

Schema addition to migration `012_palace_substrate.sql`:

```sql
CREATE TABLE nexaas_memory.backup_history (
  id              bigserial PRIMARY KEY,
  workspace       text NOT NULL,
  backup_type     text NOT NULL,
  started_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  size_bytes      bigint,
  bucket          text,
  object_key      text,
  sha256          text,
  status          text NOT NULL,
  error_message   text,
  restore_tested  boolean NOT NULL DEFAULT false,
  restore_test_at timestamptz,
  restore_passed  boolean
);

CREATE INDEX ix_backup_history_workspace
  ON nexaas_memory.backup_history (workspace, started_at DESC);
```

Week 3-4 build: `backup-workspace.sh`, `recover-workspace.sh`, OVH upload integration, restore-test logic, Ops Console backup health view, bucket provisioning during workspace deploy. ~5-6 days.

### GDPR, Retention, Right-to-Delete

Hybrid approach: **cryptographic erasure** for new data (per-subject key revocation), **tombstone redaction** for legacy data.

- **Per-subject encryption keys** in `pii_keys` table, AES-256, revoked by zeroing the key column
- **Operator UUID as canonical subject identifier**; `pii_subjects` table for end-user subjects
- **Opt-in PII marking** in skill manifests (factory interview enforces declaration)
- **Retention exception** for backup deletion (live data deleted immediately; backups age out per retention policy)
- **Recovery from old backups re-applies all pending deletions** as part of the recovery procedure
- **Right-to-access** via `gdpr-export.sh` signed operator action
- **Right-to-rectification** via supersession drawers (append correction, historical record preserved)
- **All GDPR ops actions are signed** privileged operator actions

Schema additions to migration `012_palace_substrate.sql`:

```sql
CREATE TABLE nexaas_memory.pii_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace       text NOT NULL,
  subject_id      text NOT NULL,
  subject_type    text NOT NULL,
  encryption_key  bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES nexaas_memory.operators(id),
  revoked_reason  text
);

CREATE INDEX ix_pii_keys_subject ON nexaas_memory.pii_keys (workspace, subject_id);
CREATE INDEX ix_pii_keys_active ON nexaas_memory.pii_keys (workspace) WHERE revoked_at IS NULL;

CREATE TABLE nexaas_memory.pii_redactions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace          text NOT NULL,
  original_drawer_id uuid NOT NULL,
  redacted_at        timestamptz NOT NULL DEFAULT now(),
  redacted_by        uuid NOT NULL REFERENCES nexaas_memory.operators(id),
  redaction_signature bytea NOT NULL,
  reason             text NOT NULL,
  request_reference  text,
  preserve_original  boolean NOT NULL DEFAULT false
);

CREATE INDEX ix_pii_redactions_drawer ON nexaas_memory.pii_redactions (original_drawer_id);

CREATE TABLE nexaas_memory.pii_subjects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace       text NOT NULL,
  subject_type    text NOT NULL,
  operator_id     uuid REFERENCES nexaas_memory.operators(id),
  identifiers     jsonb NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_pii_subjects_operator
  ON nexaas_memory.pii_subjects (workspace, operator_id) WHERE operator_id IS NOT NULL;
CREATE INDEX ix_pii_subjects_identifiers ON nexaas_memory.pii_subjects USING gin (identifiers);
```

Week 2-3 build: PII encryption library, TAG output handler with field encryption, drawer reader with decrypt-or-redact, factory PII interview questions, gdpr-delete/export/rectify ops actions, documentation. ~7-8 days.

### Local Skill Testing

Two-tool approach:

**`nexaas dry-run`** — fast local iteration:
- Loads skill manifest + prompt + optional task.ts
- Constructs mock or fixture-based palace context
- Calls real model by default (Sonnet at `good` tier); `--model mock` for offline/deterministic
- Runs TAG against model output with fixture's contract
- Reports routing decisions without executing side effects
- Cycle time: 5-15 seconds per run

**Sandbox workspace** on the ops VPS — end-to-end confidence:
- Real Nexaas runtime with mock/stub MCPs
- Authors deploy, trigger, and tail skills in a real environment
- `nexaas deploy skill`, `nexaas trigger`, `nexaas tail run` CLI commands

**Fixtures** are optional YAML files describing test scenarios. No mandate; authors choose. Skills contributed to the canonical library benefit from fixtures but are not blocked by their absence.

**`nexmatic-testlab`** conformance suite runs all skills (with or without fixtures) for framework-level validation.

Week 2-3 build: dry-run CLI, fixture parser, mock palace, sandbox provisioning, CLI commands. ~5-6 days.

### MCP Development Workflow

**`@nexaas/mcp-server` package** in the framework provides:
- `createMcpServer` with HTTP server, MCP protocol, health endpoint
- `server.tool(name, schema, handler)` with Zod input/output validation
- Capability conformance check at startup
- Standard error shapes (`AUTH_EXPIRED`, `RATE_LIMITED`, `EXTERNAL_DOWN`)
- Retry/backoff helpers for external API calls
- Dev mode against fixtures

**Development cycle:**
1. `nexaas create-mcp <name> --capability <cap>` scaffolds a project with stubs, tests, fixtures, Dockerfile
2. Author fills in integration logic
3. `nexaas mcp dev <name>` runs locally with hot reload
4. `nexaas mcp test <name>` runs unit + conformance tests
5. `nexaas mcp register <name> --stage experimental` adds to Nexmatic's MCP registry
6. `nexaas deploy mcp <name> --workspace <id>` installs on a workspace VPS

**Two authoring modes:**
- **Ops-flow** via `/new-mcp` slash command in Ops Console terminal — for simple integrations (single capability, few tools, API key auth)
- **Desktop authoring** with full IDE — for complex integrations (OAuth, browser state, scraping)

**All MCPs must be registered** in Nexmatic's library. Framework usage (`@nexaas/mcp-server`) is the recommended default via scaffolding but not strictly required — the registry is the gate.

**MCPs follow semver** with same propagation pattern as skills (patch immediate, minor with notification, major with approval).

All MCPs live in the Nexmatic repo under `mcp/servers/<mcp-id>/`.

Week 2-3 build: `@nexaas/mcp-server` package, `nexaas create-mcp` scaffold, CLI commands, `/new-mcp` slash command, documentation. ~7-9 days.

### Client Dashboard

**The existing client dashboard is substantially built and is the v1 product surface.** Moves to the Nexmatic repo during the Week 1 split. Extended, not rewritten.

**Already built (keep as-is):**
- Dashboard home with stats (active skills, pending approvals, actions today, usage)
- Preferences page: tone, domain, approval gates (TAG routing exposed to client), hard limits, escalation rules, notification mode
- Skills page with per-skill tabs: feedback (thumbs up/down), custom rules via **copilot chat** (client describes intent in English → Claude proposes structured rules → client applies), preferences (dynamic question-driven config), knowledge upload (per-skill RAG docs)
- Activity feed with TAG route badges
- Approvals with approve/reject actions
- Integrations with OAuth flows (Google, M365, Plaid)
- Settings with password management and 2FA (TOTP)
- Billing with Stripe integration (portal, usage, webhooks)
- Login with NextAuthJS + TOTP
- Invite flow for new users with TOTP enrollment
- Channels management

**v1 extensions:**
- **WebAuthn passkey enrollment** during setup/invite flow
- **Per-action WebAuthn signing** on approval actions and contract edits
- **Session management**: 4h sliding / 8h absolute / 2h re-auth threshold (extend NextAuth config)
- **Active sessions view** with multi-device visibility and one-tap revocation
- **Custom domains** self-service (new settings section)
- **Recovery codes** generation and management (new settings section)
- **Palace-backed data writes**: preferences, rules, knowledge, and feedback currently write to API endpoints with custom DB tables — wire through the palace so drawers capture state for CAG/RAG/audit consistency
- **Signed WAL entries** on every contract edit, preference change, approval action
- **Usage display reframed**: replace `tokensThisMonth` stat with `actionsThisMonth` or `skillRunsThisMonth` — no token counts, no provider names in client-facing views

**The copilot chat for custom rules** (skills page → Custom Rules tab) is the AI-powered contract editing UX. Client describes intent → Claude proposes → client previews → client applies with WebAuthn gesture → result writes to palace as signed drawer. This is the CAG/Contract/TAG self-service loop in one interface.

Week 3 build: WebAuthn wiring, session management extension, palace-backed writes, signed actions, custom domains, recovery codes, usage reframing. ~3-4 days (most of the hard UI is already built).

---

## Part X: Deferred to v1.1 or Later

- Phoenix cc-promote migration from bespoke Trigger.dev stack
- Client self-service skill authoring (beyond config editing and the copilot chat)
- Cross-workspace skill sharing
- Automated library curation tooling
- Persona sub-agents (L3)
- Workflow in-flight migration (drain before deploy is v1 approach)
- External witness / transparency log for WAL
- Sub-second latency on durable pause resumption
- HSM / KMS operator signing tier
- Wildcard custom domains
- Automated closet compaction cadence tuning from staleness data
- Multi-account support for capabilities (`UNIQUE (workspace, provider, account_ref)`)
- Structured brand voice editor (v1 uses free-text; structured is v1.1)
- Self-service schema extensions (v1 requires ops; v1.1 adds client-facing editor)
- Self-service email triage rule editor with Claude-assisted authoring
- Visual contract editor for non-trivial behavioral changes
- Self-service skill activation from canonical library
- Local Docker-based development environment (v1 uses ops-VPS sandbox)
- Batched WebAuthn signing for bulk approval operations
- Real-time WAL streaming to offsite backup (v1 uses nightly dumps)
- Multi-region backup storage

---

## Part XI: Open Questions

**All architectural questions have been answered and locked through the pre-v1 Q&A.** No open questions remain.

Batch 2 (closets, WAL, skill_runs, waitpoint timeouts, model selection, capability hardening): all locked.
Batch 3 (pilot lineup/organic buildout, ops notifications, dashboard auth, skill versioning, factory metrics): all locked.
Batch 4 (backup, GDPR, local testing, MCP development, client editing UI): all locked.

If new questions arise during v1 execution, add them here with the date and context. Answers should be added in-place and committed with descriptive messages.

---

## Part XII: Locked Decisions Summary

For quick reference, the architectural decisions locked through Q&A:

### Repository and Licensing

- **Two repositories**: `nexaas` (framework, Systemsaholic-owned) + `nexmatic` (business, via Nexmatic entity)
- **Proprietary LICENSE** with named perpetual grants, lawyer review required before commercial operation
- **GitHub Packages private** distribution under Systemsaholic org
- **0.x.y semver** during v1, moving to 1.x.y once framework stabilizes

### Execution Runtime

- **BullMQ + Redis** per workspace VPS for execution runtime
- **Sandboxed processors** prevent worker leaks structurally
- **Transactional outbox pattern** for Postgres↔Redis atomicity
- **`runTracker` library** owns all `skill_runs` writes with library-enforced status transitions
- **`skill_runs` denormalized index**, drawers remain authoritative, sub-agents in same table with `parent_run_id`

### Memory Substrate

- **pgvector + Voyage-3** per workspace VPS for vector retrieval (replacing legacy Qdrant)
- **Per-workspace palace** with flat metadata facets (wing/hall/room as indexed columns)
- **Append-only palace** — tombstone pattern for redaction, never hard delete
- **Closet compaction background task** with staleness telemetry and three-tier health thresholds (Healthy / Drifting / Choked)
- **Closet compaction cadence**: 5 min business / 30 min off-hours, deterministic clustering first
- **Hash-chained WAL** per workspace with sha256, lock+retry on insert
- **Bi-daily incremental WAL verify + weekly full-chain verify** per workspace

### Operator Identity and Signing

- **ed25519 signatures** on privileged WAL rows
- **Tier 1 file-based keys** for bootstrap operator, **Tier 2 WebAuthn** for all other ops and all client admins
- **Per-action signing** for client admins via WebAuthn, no session-wide blank check
- **Operator signing for all seven privileged action categories** in v1
- **Client signing first-class**: client admins sign their own waitpoint approvals, contract edits, and configuration changes

### Client Dashboard Auth

- **NextAuthJS** for session auth with OAuth (Google, Microsoft 365 primary), email+password+TOTP fallback, magic link optional
- **Session duration**: 4-hour sliding / 8-hour absolute / 2-hour silent re-auth threshold for privileged actions
- **Max 3 concurrent sessions** per client admin
- **Recovery via 10 one-time codes** in `xxxx-xxxx-xxxx` format, hashed on storage
- **Out-of-band ops recovery** as signed operator action

### TAG and Contracts

- **TAG Option C** layered policy: manifest defaults + contract overrides with authorization chain
- **Schema extensions** as workspace-level contract feature for per-client field additions

### Capabilities

- **Capability staging** — Experimental → Converging → Stable with conformance tests at Stable
- **Parallel version support** for capability major versions with 6-month deprecation windows
- **One reference Stage 3 capability** in v1 (likely email-inbox or email-outbound) with conformance test as the pattern

### Model Gateway

- **Tier-based model selection** (`cheap/good/better/best`) with provider-agnostic gateway and fallback chains
- **Claude-primary** across all tiers, with OpenAI and self-hosted fallbacks
- **`best`-tier non-Claude fallback auto-elevates** routing to `approval_required`
- **3-retry exponential backoff** before falling through (100ms, 400ms, 1s)
- **Model registry as YAML** in framework repo, tier mappings configurable per consuming business
- **Workspace-internal cost caps** (Nexmatic margin protection, not client-facing limits)
- **Client dashboard** shows usage in client-meaningful units (runs, approvals) — no token counts, no provider names, no cost abstraction leak

### Skill Versioning and Drain

- **Semver discipline**: patch auto-propagates immediately, minor preserves in-flight runs on original version, major requires drain + ops approval
- **30-day retention** for deprecated minor versions
- **Per-run force-drain** individually approved by ops
- **Multi-version runtime** loads multiple skill versions simultaneously when needed

### Waitpoints

- **Waitpoint timeout reaper** at 60-second cadence with escalate default, 7-day default timeout, 30-day ceiling with signed ops override
- **Reminder routing configurable**, defaults to same channel as original notification

### Network and Domains

- **Network topology**: Tailscale to ops VPS only, private LAN from ops to workspaces, workspace VPSes have their own public IPs with direct DNS routing
- **Self-service custom domains** with both default nexmatic.ca subdomain and custom domain active simultaneously
- **Transparent TLS management** via per-VPS Caddy + Let's Encrypt

### Ops Notifications

- **Slack + email** for ops alerts (no Telegram for ops; Telegram is client-facing)
- **Ops notification policy lives in Nexmatic** (not framework)
- **15-minute ack window + 1-hour snooze option**
- **Recurring-issue auto-escalation** after 4 unresolved acks in 24 hours
- **Tier A/B/C/D** routing to page/inbox/digest/wal-only

### Framework Upgrades

- **Orchestrated rolling upgrade** from Ops Console (Option A)
- **Five-layer validation gate**: unit+integration tests → testlab conformance → ops dogfood soak → canary client opt-ins → fleet rollout
- **`nexmatic-testlab` dedicated test workspace** with conformance suite covering every framework invariant
- **`nexmatic-ops` dogfood workspace** running real Nexmatic internal automation
- **After-hours upgrades** scheduled per workspace local timezone (2-4 AM)
- **7-day rollback window** via snapshot-based rollback
- **Schema migrations** versioned in `@nexaas/palace` with backward compatibility rules and rollback scripts

### Factory and Library

- **100% factory usage target** — bypassing the factory is a framework violation, not an operational convenience
- **Factory is the framework enforcement mechanism**, not just an authoring convenience
- **Nexaas framework does not ship archetypes** — consuming businesses provide them
- **Flow as distinct from skill** — flows are per-workspace compositions, skills are library primitives
- **Organic library buildout** — v1 ships with empty library, grows through real client work
- **`orchestrator/promotion/` and `orchestrator/sync/` stay and get implemented properly** (reversed from earlier "nuke" decision)
- **Library retrieval as a v1 framework capability** — RAG over library skills for cross-pollination
- **Improvements propagate as proposals**, not auto-updates; major version updates always require review

### Factory Success Metrics

- **19 metrics across 5 dimensions**: factory health, library health, cross-pollination, signing/audit, fleet health
- **v1-done required thresholds**: 100% factory usage, 100% privileged action signing, 100% WAL verification, >99% workspace uptime, >90% skill run success, ≥1 cross-pollination event, ≥1 accepted proposal, >70% factory completion, no unanswered Tier A alerts >1 hour
- **Ops team** reviews Factory Health view and makes the v1-done call

### Secrets Management

- **Platform secrets via sops** + deploy-time push to each VPS as `.env.platform`
- **Per-client secrets** in `integration_connections` encrypted with per-VPS master key
- **OAuth provider credentials** as Tier 1 platform secrets
- **Anthropic API key** Tier 1 (shared, Nexmatic-billed, internal cost caps)

### Sub-Agents

- **L1 focused invocations** implemented in v1
- **L2 specialist skills** in agent bundles (composition, no new primitive)
- **L3 personas** schema reserved, runtime deferred to v1.2+

### Backup

- **Dedicated OVH backup project** separate from main Nexmatic infrastructure
- **Per-workspace buckets** with per-VPS credentials
- **Daily backups** at 2 AM local time with SHA256 manifest verification
- **Bi-weekly restore-tests** that actually restore and verify
- **Retention**: 30d daily / 12w weekly / 12m monthly / 7y annual, overridable per workspace contract
- **Recovery is a signed operator action**
- **Backup failure → Tier B; restore-test failure → Tier A**

### GDPR and Privacy

- **Hybrid approach**: cryptographic erasure (per-subject key revocation) for new data + tombstone redaction for legacy
- **Per-subject keys** via AES-256, revoked by zeroing the key column
- **Operator UUID as canonical subject identifier**; `pii_subjects` table for end-user subjects
- **Opt-in PII marking** in skill manifests, factory enforces declaration
- **Retention exception** for backup deletion (live deletes immediately; backups age out naturally)
- **Recovery from old backups re-applies pending deletions**
- **Right-to-access**, **right-to-rectification**, **right-to-deletion** all supported as signed ops actions

### Local Skill Testing

- **`nexaas dry-run`** CLI with real model by default, mock via flag, fixture-based context
- **Sandbox workspace on ops VPS** for end-to-end testing
- **Fixtures are optional** — no mandate, author's choice
- **`nexmatic-testlab` conformance suite** covers all skills (with or without fixtures) for framework integrity

### MCP Development

- **`@nexaas/mcp-server`** framework package for consistent MCP authoring
- **`nexaas create-mcp`** scaffold command generates projects with stubs, tests, fixtures
- **`/new-mcp` slash command** in Ops Console for simple MCPs (ops-authored)
- **Desktop authoring** for complex MCPs (OAuth, scraping, multi-tool)
- **All MCPs must be registered** in Nexmatic's library; registration is the gate, not framework usage
- **MCPs follow semver** with same propagation rules as skills
- **All MCPs in Nexmatic repo** under `mcp/servers/<mcp-id>/`

### Client Dashboard

- **Existing client dashboard is the v1 product surface** — move to Nexmatic repo, extend not rewrite
- **All existing self-service features stay**: tone, domain, approval gates, hard limits, escalation rules, per-skill feedback/rules/preferences/knowledge, notifications, integrations, billing
- **Copilot chat for custom rules** is the AI-powered contract editing UX — client describes intent, Claude proposes, client applies with WebAuthn gesture
- **WebAuthn, session management, custom domains, recovery codes, palace-backed writes, signed actions** added as v1 extensions
- **Token display reframed** as automation activity metrics — no provider names, no cost details in client views

---

**End of plan.**

Open questions in Part XI must be answered before the affected work begins. Updates to this plan should be made by editing the file and committing with a descriptive message. Significant architectural changes should be discussed before merge.
