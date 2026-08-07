# Fleet Heartbeat — Receiver Contract

**Status: published (#216).** The framework ships the *sender*
(`packages/runtime/src/fleet/heartbeat.ts`); the *receiver* is
operator-side infrastructure (for Nexmatic-managed fleets: the Ops
Console — see the coordination issue on the Nexmatic repo). This document
is the contract between them. `tests/fleet-payload.test.ts` guards the
payload shape against this doc.

Direct adopters: with `NEXAAS_FLEET_ENDPOINT` / `NEXAAS_FLEET_TOKEN`
unset, everything below is a silent no-op. The local
`nexaas_memory.framework_heartbeat` row is still maintained.

## Endpoints (receiver implements)

| Endpoint | Method | Body | Sender cadence |
|---|---|---|---|
| `${NEXAAS_FLEET_ENDPOINT}/heartbeat` | POST | beat payload (below) | every 5 min + once at worker startup |
| `${NEXAAS_FLEET_ENDPOINT}/events` | POST | fleet event (below) | on occurrence |

- **Auth**: `Authorization: Bearer ${NEXAAS_FLEET_TOKEN}` — the token is
  workspace-scoped, issued by the receiver at provisioning. The receiver
  MUST reject a token/workspace mismatch (a compromised VPS must not be
  able to impersonate another workspace).
- **Sender timeout**: 10s; any non-2xx or network error is recorded
  locally (WAL `framework_heartbeat_failed` / `fleet_event_failed`) and
  retried on the next natural occasion. The sender never queues or blocks.
- 2xx bodies are ignored by the sender — receivers may return `{}`.

## Beat payload (`payload_version: 3`)

Every collector is best-effort: a broken subsystem nulls its field rather
than blocking the beat — the beat must survive precisely the breakage it
reports. Receivers MUST tolerate any nullable field being null and MUST
ignore unknown fields (additive evolution; `payload_version` bumps only
on breaking changes).

| Field | Type | Notes |
|---|---|---|
| `payload_version` | `3` | |
| `workspace` | string | |
| `version` | string | VERSION file (release stamp) |
| `commit_sha`, `branch`, `describe` | string \| null | git identity; `describe` is release-aware |
| `channel` | string \| null | `stable` / `canary` / null (legacy tracking) |
| `hostname` | string | |
| `started_at` | ISO string | worker process start |
| `now` | ISO string | beat emission time |
| `worker_status` | `"running"` | see *Missed-beat semantics* — a stopped worker sends nothing |
| `uptime_s` | number | |
| `runs_24h` | object \| null | `{ completed, failed, skipped, success_rate_pct \| null }` |
| `spend` | object \| null | `{ day, spent_usd, budget_usd \| null, paused }` (#215) |
| `migrations` | object \| null | `{ applied, pending }` — `pending > 0` after an upgrade is a red flag |
| `conformance` | object \| null | last `nexaas conformance` result (`{ passed, failed, skipped, at, … }` as recorded in `workspace_kv.last_conformance`) |
| `queue` | object \| null | `{ waiting, active, delayed, failed, paused }` |
| `health` | object \| null | `{ status: healthy\|degraded\|critical\|unknown, alerts, alert_components[], checked_at }` — latest in-process health-monitor report (≤5 min old on a healthy worker) |

## Fleet events

```json
{
  "payload_version": 3,
  "workspace": "...", "hostname": "...", "at": "ISO",
  "type": "silent_failure | spend_budget_exceeded | ...",
  "severity": "page | digest",
  "title": "...", "body": "...",
  "dedupe_key": "optional receiver-side dedupe",
  "data": { }
}
```

**Severity discipline (solo-operator rule)** — the sender classifies, the
receiver applies policy:

| `severity` | Meaning | Receiver policy (recommended) |
|---|---|---|
| `page` | A client workspace is broken in a way it cannot report locally, or money/integrity is at stake | Immediate operator notification |
| `digest` | Worth knowing, not worth waking for | Daily rollup |

Current sender classifications: `silent_failure` → **page** (the
workspace's own alert channel may be exactly what's broken);
`spend_budget_exceeded` → **page**. New event types MUST be added to this
table.

## Missed-beat semantics (receiver-side liveness)

The sender lives inside the worker process — **a stopped worker sends
nothing**, which is by design the strongest signal. The receiver owns
liveness detection:

- Expect a beat per workspace every 5 min. Recommended: **flag at 3
  consecutive misses (~15 min blind), page at 6 (~30 min)** — tolerant of
  restarts/upgrades (an upgrade gap is one or two beats; the post-restart
  beat fires at startup).
- A beat with `health.status: "critical"` or `queue.paused: true` or
  `migrations.pending > 0` is receiver-side judgment — the contract only
  requires surfacing, not paging.
- A cron-side out-of-process sender (beats even when the worker is down,
  with `worker_status: "stopped"`) was considered and deferred: it dilutes
  the missed-beat signal and adds a second delivery path to secure. The
  receiver's missed-beat detection covers the stopped-worker case.

## Local audit trail (sender side)

| WAL op | When |
|---|---|
| `framework_heartbeat_sent` / `framework_heartbeat_failed` / `framework_heartbeat_skipped` | per beat (skipped = unconfigured, the direct-adopter steady state) |
| `fleet_event_sent` / `fleet_event_failed` | per escalated event |

Plus the single-row `nexaas_memory.framework_heartbeat` state (last push
status/HTTP code) readable via `nexaas status`.
