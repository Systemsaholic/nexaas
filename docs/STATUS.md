# Build Status — retired

**This document is retired (#258).** It was a point-in-time build snapshot
from 2026-04-20 that went stale immediately (it discussed issues #25–#45;
the repo moved on without it). Point-in-time snapshots don't survive contact
with a moving codebase, so nothing replaces it in kind.

Where the same questions are answered now, kept current by process rather
than by intention:

- **What shipped, when** → [`CHANGELOG.md`](../CHANGELOG.md) — every release,
  with its migrations, updated as part of the release ritual.
- **How releases and channels work** → [`docs/releases.md`](releases.md).
- **What the framework's live contracts are** → [`docs/contracts.md`](contracts.md)
  — WAL ops, env vars, worker routes; CI fails when code drifts from it.
- **What's planned / in flight** → the
  [issue tracker](https://github.com/Systemsaholic/nexaas/issues) — the
  framework-hardening umbrella (#253) tracks current workstreams.
- **Whether a given install is healthy** → `nexaas health` and
  `nexaas conformance` on the workspace itself.
