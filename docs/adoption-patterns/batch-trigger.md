# Batch trigger — accumulate drawers and fire on count / age / cron / deadline

*v0.1 — framework primitive shipped (#80). End-to-end validation pending on first adopter bucket.*

Pattern for any flow that wants to coalesce events before processing. Sibling
to inbound-message and notification-dispatcher primitives — same poll-claim-
dispatch skeleton, just keyed on (bucket, fire_when) instead of (drawer_id) or
(idempotency_key).

## When to use this pattern

- You'd otherwise send one notification per event and end up rate-limited or
  causing notification fatigue ("10 alerts → 1 Telegram digest")
- You're paying per-API-call and want to batch ("send 100 enrichment calls per
  request, not 100 individual requests")
- You want a periodic digest ("collect entries for 10 days, send weekly summary")
- You want hybrid count-or-deadline behavior ("send when 5 entries OR end of
  business day, whichever comes first")

## When **not** to use

- The event is itself a batch (one webhook delivers 50 records as one drawer —
  a normal trigger handles it; batching adds latency for nothing)
- Real-time delivery is the requirement (sub-poll-tick latency matters; batch
  dispatcher polls every 5s by default)
- The consumer needs to maintain running state across batches (use a stateful
  cron skill with palace memory instead — batch fires are stateless)

## Producer side

Anything that wants to contribute writes a drawer to
`batch.<bucket>.pending.<arbitrary-id>`. Drawer payload is opaque to the
framework — the consumer skill defines the per-bucket schema.

```typescript
await session.writeDrawer(
  { wing: "batch", hall: "alerts.critical", room: `pending.${alertId}` },
  JSON.stringify({
    severity: "critical",
    source: "phoenix-monitor",
    summary: "Disk usage 95%",
    occurred_at: new Date().toISOString(),
  }),
);
```

Producers don't need to know whether anything subscribes; the framework just
holds drawers until a consumer's `fire_when` matches (or never, if no
subscriber exists).

## Consumer skill manifest

```yaml
id: ops/critical-alert-digest
version: "1.0.0"
execution:
  type: ai-skill

triggers:
  - type: batch
    bucket: alerts.critical
    fire_when:
      any_of:
        - count_at_least: 10           # 10 critical alerts → fire
        - oldest_age_at_least: "1h"    # OR oldest > 1h → fire
        - cron: "0 9 * * MON"          # OR Monday 9am digest
    on_empty: skip                     # default — cron fires skip empty buckets
    ordering: arrival                  # default — items in oldest-first order
```

The consumer's run receives `triggerPayload.batch_items` as an array:

```json
{
  "bucket": "alerts.critical",
  "batch_id": "<uuid>",
  "fire_reason": "count_at_least:10",
  "items": [
    { "drawer_id": "<uuid>", "content": "<original drawer payload>", "created_at": "<ISO>" },
    ...
  ]
}
```

## `fire_when` conditions

| Condition | Type | Notes |
|---|---|---|
| `count_at_least: N` | number | Fires when the bucket holds ≥ N pending items |
| `oldest_age_at_least: "1h"` | duration string (`s`/`m`/`h`/`d`) or seconds | Fires when the oldest pending item exceeds the threshold |
| `cron: "0 9 * * MON"` | standard 5- or 6-field cron expression | Fires when the cron crosses, evaluated each poll tick |
| `at: "2026-05-15T00:00:00Z"` | ISO-8601 timestamp | One-shot deadline; fires the first poll after the time passes |

Multiple conditions in `any_of` fire on whichever matches first. Use
`fire_when.any_of` exclusively in v1; `all_of` semantics aren't supported
(file an issue if needed).

## `on_empty` policy

- `skip` (default) — cron and `at` conditions never fire when the bucket is
  empty. Useful for digests where "nothing happened today" is uninteresting.
- `fire-with-empty` — cron and `at` fire even with no items. The consumer
  receives `items: []`. Useful for "always send a daily 'all clear' confirmation."

`count_at_least` and `oldest_age_at_least` never fire on an empty bucket
regardless of this flag.

## Atomicity

Each fire claims a `batch_dispatches` row tagged with the item drawer ids it
took. Subsequent polls exclude items already in any open dispatch (claimed,
dispatched, or completed), so:

- A multi-worker race can't double-fire — only one worker wins the claim.
- Items stay associated with their claim until the consumer succeeds; on
  failure the dispatch goes to `status='failed'` and items remain unbillable
  to a new batch (operators clear the failed dispatch row to retry).

## Observation path

| Stage | WAL op | SQL |
|---|---|---|
| Bucket fired | `batch_dispatched` | `SELECT * FROM wal WHERE op = 'batch_dispatched' ORDER BY created_at DESC LIMIT 10;` |
| Claim race lost | `batch_claim_failed` | `SELECT * FROM wal WHERE op = 'batch_claim_failed' ORDER BY created_at DESC LIMIT 10;` |
| Consumer enqueue failed | `batch_consumer_failed` | `SELECT * FROM wal WHERE op = 'batch_consumer_failed' ORDER BY created_at DESC LIMIT 10;` |
| In-flight batches | (no WAL — table state) | `SELECT bucket, batch_id, status, array_length(item_drawer_ids, 1) AS n, fire_reason FROM nexaas_memory.batch_dispatches WHERE status IN ('claimed', 'dispatched') ORDER BY claimed_at DESC;` |
| Pending bucket size | (no WAL — events table) | `SELECT hall AS bucket, count(*) FROM nexaas_memory.events WHERE wing='batch' AND room LIKE 'pending.%' AND dormant_signal IS NULL GROUP BY hall;` |

## Known limits (v1)

- **One consumer per bucket.** If two skills declare `triggers.batch.bucket:
  alerts.critical`, the second is ignored and a warning logs at index build.
  Multi-consumer fan-out is tracked in #80 follow-up.
- **No item archival policy.** On consumer success, items remain in
  `batch.<bucket>.pending.*` but are excluded from future batches via the
  dispatch's `item_drawer_ids` filter. A reaper that moves them to
  `batch.<bucket>.archived.*` after consumer success is a follow-up.
- **Cron evaluated per poll tick.** Default poll is 5s, so cron fires can be
  up to ~5s late. Acceptable for digest cadence; not suitable for sub-second
  scheduling.
- **`recency-first` ordering returns items LIFO,** but the oldest-age check
  always uses the literal oldest pending item across the batch (so age-based
  fires aren't affected by the `ordering` flag).

## Rollback

- **Stop new fires:** revert the consumer skill so the bucket has no
  subscriber; pending drawers accumulate but never dispatch.
- **Clear stuck dispatches:** `UPDATE nexaas_memory.batch_dispatches SET status='failed' WHERE status='claimed' AND claimed_at < now() - interval '10 minutes';`
- **Full rollback of the primitive:** `git revert <this-commit>`. Migration
  019 stays applied (the table is harmless when unused); future deploys can
  drop it once everyone's off the trigger.

## Canary status

- Framework primitive: shipped (#80)
- Phoenix HR weekly digest: pending Phoenix-side adoption
- Nexmatic Email Autopilot scheduled broadcasts: pending Nexmatic-side
  manifest authoring (#78 PR C is now superseded by this primitive)
- BSBC end-to-end validation: pending — to be filed as a synthetic skill
  exercising count + age + cron in a single bucket

This doc will be revised once the first adopter validates end-to-end.
