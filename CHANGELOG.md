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

### Fixed
- `VERSION` stamped to 0.3.0 — v0.3.0 shipped self-reporting `0.2.0` in the
  fleet heartbeat because the stamp wasn't part of the release procedure;
  `docs/releases.md` now lists it as step 1

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
