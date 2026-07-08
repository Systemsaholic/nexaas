# Changelog

All notable framework changes, newest first. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); releases are annotated git
tags `vX.Y.Z`. See [`docs/releases.md`](docs/releases.md) for how releases are
cut, promoted through channels, and rolled back.

Every release section must include a **Migrations** subsection listing which
`database/migrations/` files the release introduces — and each of those
migrations must keep the previous release's code working (one-release
backward compatibility; see the rollback policy in `docs/releases.md`).

## Unreleased

_Nothing yet._

## v0.3.9 — 2026-07-08

WAL integrity hardening (#254, H1 of the framework-hardening v2 umbrella #253)
bundled with the ai-skill / MCP / approvals fixes that accumulated on main
since v0.3.8. One migration (029); rollback to v0.3.8 is code-unconstrained but
subject to the 029 verify caveat below.

### Fixed
- WAL hashing now covers nested payload fields (#254). The v1 canonicalizer
  hashed payloads with `JSON.stringify(payload, Object.keys(payload).sort())`;
  a replacer *array* is a key allowlist applied at every depth, so nested
  objects serialized as `{}` — nested WAL fields could be altered in the DB
  with no hash change, and self-consistent verification never surfaced it
  across 8.9M+ Phoenix rows. New rows are written under a versioned `canon_v2`
  algorithm (`nexaas_memory.wal_hash_v2`, one IMMUTABLE SQL function shared by
  writer and verifier, hashing over jsonb `payload::text`); nested tamper is
  now detected. Pre-#254 rows keep verifying under the historical v1 JS
  canonicalizer via a new `canon_version` column — no rewrite of the
  append-only chain (the #234/028 playbook).
- The four raw-SQL CLI WAL writers (`library`, `propagate`, `gdpr`,
  `seed-palace`) now route through `appendWal` (#254), gaining canonical v2
  hashes and the per-workspace advisory lock (#71) instead of hand-rolled
  `sha256('<field-json>')` inserts. Their pre-existing rows are flagged
  `integrity_exempt` (linkage-only anchors, same as `workspace_genesis`).
- ai-skill prompts now inject the triggering inbound message verbatim, and pin
  the resumption `trigger_payload` into handler context so resumed runs see the
  original trigger.
- MCP client request timeout is method-aware: `tools/call` gets 10 min
  (`NEXAAS_MCP_TOOL_TIMEOUT_MS`) while handshake calls keep 30s.
- Streaming watchdog chunk-idle default raised 60s → 180s
  (`NEXAAS_STREAM_IDLE_MS`) — 60s was too aggressive for large tool-result
  contexts.
- Approval edit decisions can carry a `payload_override` to the handler, plus a
  `GET /api/approvals/by-message/:messageId` lookup on the worker.
- Notification dispatcher prefers `payload.summary` over a raw-JSON preview in
  approval renders; `produce_output` merges manifest-declared `parse_mode` into
  the payload (an explicit payload still wins).

### Changed
- Main is now branch-protected; framework changes land via feature branch + PR
  (#264). `.gitignore` covers local `.mcp.json` and stray client-reports output.

### Migrations
- `029_wal_canon_v2.sql` — additive `wal.canon_version smallint DEFAULT 1`,
  the `nexaas_memory.wal_hash_v2()` function, and an `integrity_exempt` flag on
  existing raw-CLI-written rows. Backward compatible with v0.3.8 code, which
  ignores `canon_version` and recomputes under v1 — but v0.3.8 verify will flag
  v2-written rows broken, so do NOT run pre-029 verify against a v2 chain; the
  column is the guard. Rollback of code is otherwise unconstrained.

## v0.3.8 — 2026-06-29

Two observability guards for silent fresh-client-instance failures, raised by
Nexmatic (nexmatic#12/#13). No migrations; rollback to v0.3.7 unconstrained.

### Fixed
- Unrecognized `execution.type` no longer silently no-ops (#249): the worker
  routes by `execution.type` (`shell`/`ai-skill`); any other value (e.g. a
  catalog manifest's `type: simple`) fell through to the pillar pipeline and
  completed in ~3s with `returnvalue: null`, no logs, no drawer. Now it's a
  loud failed run + terminal drawer (`unrecognized_execution_type`) + WAL +
  actionable error. Not broadening `simple` → ai (that's the documented
  opt-in) — just making the misconfiguration visible.
- Worker warns at startup on missing/placeholder `ANTHROPIC_API_KEY` (#250):
  previously every AI skill failed with `model_all_providers_failed` and no
  upfront signal. Warns (doesn't exit — shell-only workspaces are valid),
  alongside the existing snap-node/tsx startup guards.

## v0.3.7 — 2026-06-26

Two field-surfaced fixes. No migrations; rollback to v0.3.6 unconstrained.

### Fixed
- Health-monitor staleness is now cadence-aware (#245): the flat ">120 min"
  threshold flagged every daily/weekly/bursty skill as "stale", burying real
  alerts. Now derives each skill's own median run-gap (≥3 runs/14d, gap ≥20m)
  and only alerts at 3× that (floor 180m). Validated on live Phoenix data:
  15 false positives → 0.
- `loadSkillManifest` accepts contract.yaml shape (#246): registered
  contract-style skills (`skill:`/`category:`, no `id:`) 404'd on
  `POST /api/skills/trigger` despite register-skill accepting them (PR #170
  made them resolvable but left trigger validation native-only). Now derives
  the id the same way register-skill's normalizeManifest does. Native
  manifests unchanged.

## v0.3.6 — 2026-06-22

Backlog batch + a correction. No migrations; rollback to v0.3.5 unconstrained.

### Added
- Per-MCP tool allowlist for ai-skill manifests (#196): `mcp_servers` entries
  may be `{ id, tools: [...] }` to load only named tools (plain string = load
  all, back-compat). Filters at tool-load time; warns on unknown allowlisted
  names and on >75-tool bloat. Avoids the 145-tool / ~45K-token first-call
  timeout (#197 RCA). `dry-run` shows per-MCP tool counts.
- `POST /api/approvals/:signal/resolve` (#205): direct approval resolution for
  ops dashboards — synchronous alternative to the drawer-then-poll path,
  removing the ~3s resolver latency. Same `resolveWaitpoint` + handler-enqueue
  + WAL outcome as a channel button click; bearer-authed; 200/400/404/409.

### Fixed
- `nexaas upgrade` now actually uses `npm install --include=dev` (#241). v0.3.5
  claimed this fix but only VERSION + CHANGELOG were committed — the code edit
  was never shipped, so v0.3.5/stable still pruned typescript and broke the
  build when a release changed root package.json. The real fix lands here.

## v0.3.5 — 2026-06-19

Deploy-tooling fix found by the v0.3.4 testlab upgrade. No migrations;
rollback to v0.3.4 unconstrained.

### Fixed
- `nexaas upgrade` reinstalled dependencies with `npm install --production`
  when package.json/lock changed, pruning `typescript` (a devDependency) —
  so the very next `npm run build` (`tsc`) failed with the build aborting
  the upgrade. Now uses `--include=dev`, matching `nexaas init`. Surfaced
  when v0.3.4 became the first release since channels to change root
  `package.json` (adding the palace MCP server to `workspaces`).

## v0.3.4 — 2026-06-19

WAL-integrity fix (#234) — forward fix (#235, palace MCP now writes via
`appendWal`) plus the `integrity_exempt` backlog repair. Migration 028;
rollback to v0.3.3 safe. Unblocks Phoenix, which takes #231 + #234 together.

### Fixed
- Palace MCP `palace_write` now writes its WAL row via the canonical
  `appendWal` instead of a hand-rolled INSERT with a bogus
  `sha256('palace-write-'||ts)` hash and no advisory lock (#234, #235).
- WAL integrity remediation (#234): migration 028 adds `wal.integrity_exempt`
  and flags the pre-fix `palace_mcp_write` backlog (whose hashes were
  `sha256('palace-write-'||ts)`, never canonical). `verifyWalChain` skips
  hash *recomputation* for flagged rows — like the `workspace_genesis`
  anchor — while still verifying their `prev_hash` linkage, and reports the
  skipped count. Restores `verify-wal --full` / the conformance gate on
  affected workspaces without rewriting the append-only chain. Post-#234
  `palace_mcp_write` rows (written via `appendWal`, PR #235) are not flagged
  and are fully verified; genuine tampering of any non-exempt row is still
  caught. Pairs with the forward fix in #235.

### Migrations
- `028_wal_integrity_exempt.sql` — adds `wal.integrity_exempt boolean`
  (metadata-only default on PG 11+) and flags existing `palace_mcp_write`
  rows. Additive; rollback to v0.3.3 safe (older code ignores the column).

## v0.3.3 — 2026-06-19

Fixes the waitpoint-reaper re-alert storm found in the v0.3.2 stable soak
(#231). One additive migration; rollback to v0.3.2 unconstrained.

### Fixed
- Waitpoint timeout reaper re-alerted on the same expired waitpoint every
  60s tick forever — the `escalate` policy (default) wrote an ops_alert but
  never marked the waitpoint terminal (#231). Phoenix logged ~35k
  severity-high `waitpoint_timeout` alerts per 12h off ~295 abandoned
  approvals. Expiry is now single-fire via `events.timeout_handled_at`;
  `escalate` keeps `dormant_signal` set so the waitpoint stays resolvable
  by a human. Conformance gains a `waitpoint-expiry` regression check.

### Migrations
- `027_waitpoint_timeout_handled.sql` — adds nullable
  `events.timeout_handled_at` + partial index; backfills currently-expired
  active waitpoints as handled (silences the existing backlog with zero
  further alerts). Additive/nullable — rollback to v0.3.2 unconstrained.

## v0.3.2 — 2026-06-10

Hotfix: the v0.3.1 Phoenix canary caught a production-scale OOM in WAL
chain verification. No new migrations; rollback to v0.3.1 unconstrained.

### Fixed
- `verifyWalChain` streams the chain in 5000-row keyset batches — the
  previous single unbounded SELECT materialized every row and exhausted the
  V8 heap on production-sized WALs (node OOM-crash, found by the v0.3.1
  Phoenix canary's conformance run against 1.34M rows). Tamper detection
  semantics unchanged across batch boundaries.
- Conformance `wal-chain` check verifies a recent window (last 5000
  entries) instead of genesis-to-tip — right-sized for a routine gate;
  `nexaas verify-wal --full` remains the audit mode (now memory-safe).
- `nexaas verify-wal` default was labeled "incremental" but scanned the
  full chain; it is now a true recent window (last 10,000 entries).

## v0.3.1 — 2026-06-10

Production-hardening tracks 4–6 (#219): fleet observability, security
surface, zero-touch onboarding. Numbered as a patch at the operator's call;
content is additive (the releases.md semver guidance would say minor) — no
breaking changes either way.

### Added
- Fleet heartbeat payload v3 (#216): release `describe` + channel, 24h run
  error rates, daily spend/budget state, pending migrations, last
  conformance result, queue depths — all best-effort collectors
- `POST {fleet}/events` escalation path + `pushFleetEvent()`: silent-failure
  watchdog escalates upstream even with no local channel role; spend-budget
  breach pages the fleet (one event per workspace-day)
- `nexaas conformance` persists its result to `workspace_kv.last_conformance`
  for the heartbeat to carry
- Security surface hardening (#217): bearerAuth on `/api/pa/message`,
  `/api/ingest`, `/api/addons/activate` (previously open even with a token
  configured); dual-accept token rotation via
  `NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS`; per-VPS token generated by
  `nexaas init`; `NEXAAS_WORKER_BIND` knob; `.env` 0600 re-asserted on
  upgrade; `secrets-hygiene` conformance check; `docs/security-surface.md`
- Zero-touch onboarding (#218): `nexaas init` runs migrations through the
  shared tracked runner (canonical tracker populated from minute one;
  inapplicable pre-palace legacy migrations recorded-as-resolved), honors
  provisioner-supplied `DATABASE_URL` (no more password rotation on
  re-run), writes the `workspace_config` row + `--channel`, passes fleet
  env through to `.env`, and ends with a conformance gate (exit 1 = not a
  validated install). New `nexaas validate-manifest` fail-closed check;
  `docs/zero-touch-onboarding.md` provisioner contract

### Fixed
- `nexaas init` no longer reads `/dev/stdin` mid-run (a leftover that hung
  TTY sessions and ate piped input) and no longer rotates the DB password
  on every re-run
- Migration 012 no longer self-records into the legacy `public`
  schema_migrations — the statement failed on bare databases and, under the
  tracked transactional runner, rolled back the entire palace substrate
  (in-place patch per the 024 precedent)
- Worker startup reconciles unowned persistent queue pauses: a BullMQ pause
  survives in Redis across restarts and DB restores, but its owner (budget
  marker, 429 timer) may not — the queue would stay paused forever. Found
  live via conformance; the production analogue is a backup restore (#217)
- `VERSION` stamped to 0.3.0 — v0.3.0 shipped self-reporting `0.2.0` in the
  fleet heartbeat because the stamp wasn't part of the release procedure;
  `docs/releases.md` now lists it as step 1

### Migrations
- None new. `012_palace_substrate.sql` was patched **in place** (its legacy
  self-record INSERT removed — it rolled back the whole substrate on bare
  databases under the tracked runner). Filename-keyed tracking makes the
  patch invisible to every deploy that already ran 012; fresh installs get
  the working version. Rollback to v0.3.0 is unconstrained (code-only, no
  schema delta).

## v0.3.0 — 2026-06-10

First channel-cut release. Rolls up everything on `main` since v0.2.0
(2026-04-19): the production-hardening program's first three tracks (#219),
the PA delivery system, inbound/notification dispatch, and the reliability
batch proven on the Phoenix canary. Highlights below; migrations are the
complete list.

### Added
- `nexaas conformance` — end-to-end install proof at $0 AI spend: pillar
  pipeline against a local mock model, queue→worker round-trip, waitpoint
  matching, WAL integrity, migration state (#213, #220)
- Release engineering for `nexaas upgrade`: release channels
  (`--channel stable|canary`), tag pinning (`--to vX.Y.Z`), code-only
  rollback (`--rollback`), and a post-upgrade conformance gate with
  auto-rollback (`--no-verify` to skip) (#214, #222)
- Per-workspace daily AI spend budget — hard stop with persistent queue
  pause/resume, `nexaas config set spend-budget|spend-override`, health
  visibility, fallback-chain guard (#215, #221)
- `nexaas status` reports running framework version (`git describe`) and
  configured release channel (#214)
- `nexaas migration-state` — applied/pending migrations from the canonical
  tracker (#184)
- PA delivery system: threads, delivery markers, urgency hold tiers,
  claim/release lifecycle (#150s–#180s arc)
- Inbound/notification dispatch: `notification_dispatches`,
  `inbound_dispatches`, batch dispatcher, inbound-match waitpoint HTTP API
- Chain reliability: required outputs + `chain_signal` drawer kind for
  multi-skill chains (#181)
- Worker refuses snap node + tsx wrapping at startup (deploy-time guard)

### Fixed
- PA delivery: `pa_delivery_marker.status` accepts NULL end-to-end —
  `enqueueDelivery` writes NULL, claim accepts NULL (migration 025, #206)
- ai-skill: streaming with per-chunk idle timeout (#197); `last_activity`
  heartbeats during long streaming turns — no more false-orphan reconciles (#199)
- Scheduler: cron `jobName` varies per trigger so multi-cron manifests don't
  collapse into one repeatable (#193)
- Migration 024 drops vestigial `public.{event_runs,job_queue}` FK-holders
  before their referenced tables (#210)

### Migrations (since v0.2.0 — all one-release backward compatible)
- `016_notification_dispatches.sql` — new table (additive)
- `017_inbound_dispatches.sql` — new table (additive)
- `018_inbound_match_waitpoint_index.sql` — index only
- `019_batch_dispatches.sql` — new table (additive)
- `020_pa_threads.sql` — new table (additive)
- `021_pa_delivery_marker.sql` — new table (additive)
- `022_pa_delivery_claimed_status.sql` — widens a CHECK constraint (relaxation)
- `023_pa_delivery_release_at.sql` — adds a nullable column
- `024_drop_vestigial_public_tables.sql` — drops unused `public.*` tables;
  two-phase removal (no shipped code has read them for many releases)
- `025_pa_delivery_marker_status_nullable.sql` — relaxes a NOT NULL;
  backward-compatible with code that still writes a status
- `026_spend_governance.sql` — adds nullable
  `workspace_config.spend_daily_budget_usd` + new `spend_daily` table
  (additive; NULL budget = unlimited, prior code unaffected)

## v0.2.0 — 2026-04-19

Fleet versioning + heartbeat; zero-touch `nexaas init` bootstrap. Pre-dates
this changelog — see git history.
