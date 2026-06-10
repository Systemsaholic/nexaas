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

### Added
- `nexaas conformance` — end-to-end install proof at $0 AI spend: pillar
  pipeline against a local mock model, queue→worker round-trip, waitpoint
  matching, WAL integrity, migration state (#213, #220)
- Release engineering for `nexaas upgrade`: release channels
  (`--channel stable|canary`), tag pinning (`--to vX.Y.Z`), code-only
  rollback (`--rollback`), and a post-upgrade conformance gate with
  auto-rollback (`--no-verify` to skip) (#214)
- `nexaas status` reports running framework version (`git describe`) and
  configured release channel (#214)
- `nexaas migration-state` — applied/pending migrations from the canonical
  tracker
- Chain reliability: required outputs + `chain_signal` drawer kind for
  multi-skill chains (#181)
- Worker refuses snap node + tsx wrapping at startup (deploy-time guard)

### Fixed
- PA delivery: `pa_delivery_marker.status` accepts NULL end-to-end —
  `enqueueDelivery` writes NULL, claim accepts NULL (migration 025)
- ai-skill: streaming with per-chunk idle timeout; `last_activity`
  heartbeats during long streaming turns (no more false-orphan reconciles)
- Scheduler: cron `jobName` varies per trigger so multi-cron manifests don't
  collapse into one repeatable
- Migration 024 drops vestigial `public.{event_runs,job_queue}` (and earlier
  `public.{workspace_skills,events,agent_memory}`) ahead of table recreation

### Migrations
- `024_drop_vestigial_public_tables.sql` — drops unused `public.*` tables;
  no `nexaas_memory` reads affected
- `025_pa_delivery_marker_status_nullable.sql` — relaxes a NOT NULL;
  backward-compatible with code that still writes a status
