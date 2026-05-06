# RFC 0001 — Skill Concurrency Groups

**Status:** Proposed
**Authored:** 2026-05-06 (Phoenix canary)
**Owners:** Phoenix Voyages (canary), Nexaas core
**Targets:** `@nexaas/runtime` (worker, shell-skill, ai-skill), `@nexaas/cli` (register-skill)

---

## 1. Problem

Skills that share a backing resource (a SQLite DB, a third-party API rate limit, a single-writer file) collide when their cron schedules align. The runtime currently has two concurrency knobs:

- **Worker-level concurrency** (`NEXAAS_WORKER_CONCURRENCY`, default 5) — how many jobs the BullMQ worker pulls in parallel. Coarse.
- **BullMQ rate `limiter`** (`{ max, duration }`) — global throttle. Coarser still.

Neither expresses *"these skills must not run at the same time as each other, but may run in parallel with everything else"*. Today the only workarounds are:

1. **Hand-stagger crons** by minute (e.g. `:23 */4` to dodge `*/15`). Brittle — every new skill that lands on the same DB has to rediscover the map.
2. **Make the script tolerate contention** (longer `busy_timeout`, retries). Hides the issue, doesn't fix it. Long writers still starve short ones.
3. **Drop worker concurrency to 1.** Sledgehammer — kills throughput for unrelated skills.

Phoenix has hit this three times in the last month on `data/onboarding.db` (writers: `engagement-sync`, `failure-monitor`, `followup-dispatcher`, `stripe-billing-sync`, `welcome-from-{al,mireille,seb}`, `lms-invite`, `moodle-auto-enroll`). Most recent failure: `hr/stripe-billing-sync` died with `sqlite3.OperationalError: database is locked` on 2026-05-06 12:15 UTC, second consecutive run, blocked behind `engagement-sync`'s per-row HTTP+commit loop.

This pattern will recur in any workspace whose skills coalesce around shared state.

## 2. Proposal

Add a manifest-level field that declares mutual-exclusion groups. Skills in the same group serialize within the worker; skills in different groups (or no group) parallelize as today.

```yaml
# nexaas-skills/hr/stripe-billing-sync/skill.yaml
id: hr/stripe-billing-sync
concurrency_groups:
  - sqlite:data/onboarding.db
```

Multiple groups per skill are allowed (skill belongs to all of them). A job acquires every declared group lock before executing and releases all on completion or failure.

### Naming convention

Free-form strings. Two reserved prefixes for clarity, neither enforced by the runtime:

- `sqlite:<repo-relative-path>` — file-backed SQLite DBs
- `api:<vendor>` — third-party rate-limit groups (e.g. `api:moodle-token1`)

Workspaces can invent their own (`mailbox:info@`, `cdn:r2-uploads`).

## 3. Design

### 3.1 Single-worker (Phoenix today)

In-process semaphore keyed on group name. Cheap, no Redis round-trip, fits the current `startWorker(workspaceId, concurrency=5)` model.

```ts
// packages/runtime/src/concurrency-groups.ts
const locks = new Map<string, Promise<void>>();

export async function withGroups<T>(
  groups: string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (!groups.length) return fn();
  // Acquire in sorted order to prevent deadlock on multi-group skills
  const sorted = [...new Set(groups)].sort();
  const release: (() => void)[] = [];
  for (const g of sorted) {
    const prev = locks.get(g) ?? Promise.resolve();
    let releaseThis!: () => void;
    const next = new Promise<void>((r) => (releaseThis = r));
    locks.set(g, prev.then(() => next));
    await prev;
    release.push(() => {
      releaseThis();
      // Garbage-collect: if we're the tail, drop the entry
      if (locks.get(g) === next) locks.delete(g);
    });
  }
  try {
    return await fn();
  } finally {
    for (const r of release) r();
  }
}
```

Wired into `runShellSkill` and `runAiSkill`:

```ts
// shell-skill.ts
export async function runShellSkill(workspace, manifest, context) {
  return withGroups(manifest.concurrency_groups ?? [], async () => {
    // existing body
  });
}
```

### 3.2 Multi-worker (future)

When a workspace runs >1 worker (horizontal scale), in-process is insufficient. Swap the in-process map for Redis SET-NX locks with TTL refresh:

```ts
// Same withGroups() signature, Redis-backed
const key = `nexaas:lock:${workspace}:${group}`;
// SET key worker-id NX PX 60000, refresh every 30s, DEL on release
```

The runtime picks based on `NEXAAS_LOCK_BACKEND=memory|redis` (default `memory` for backward compat). Phoenix stays on memory for now; operator-managed deployments flip to redis.

### 3.3 Manifest schema (Zod, `@nexaas/manifest`)

```ts
concurrency_groups: z.array(z.string().min(1).max(64)).optional()
```

No validation of values — strings are intentional opaqueness.

### 3.4 Observability

Two additions, neither blocking:

1. WAL events `lock_acquired` / `lock_released` with `{ skill_id, run_id, group, wait_ms }`. Lets `nexaas doctor` surface contention: *"hr/stripe-billing-sync waited 47s on sqlite:data/onboarding.db (held by hr/engagement-sync)"*.
2. `nexaas register-skill` warning when registering a skill into a group that already has another active member with an overlapping cron schedule. Pure ergonomics — no enforcement.

## 4. Why not other approaches

- **Per-skill BullMQ queue with `concurrency: 1`.** One queue per group works (BullMQ does support this via separate `Queue` instances), but doubles the operational surface (Bull Board, schedulers, repeat keys) and breaks the workspace-level rate limiter. In-process semaphore reuses the existing single queue.
- **BullMQ `groupKey` (Pro feature).** Closed-source, license cost. Not available in OSS BullMQ.
- **Job priority.** Solves "preempt", not "serialize." Long writers still block short ones.
- **External advisory locks (Postgres `pg_advisory_lock`).** Adds a Postgres dependency for shell skills that have no other reason to touch Postgres. Redis is already required.

## 5. Migration

Backward-compatible, opt-in. Skills without `concurrency_groups` behave identically.

Phoenix migration target (illustrative — workspace, not framework):

```yaml
# Every HR skill that opens data/onboarding.db
concurrency_groups: [sqlite:data/onboarding.db]
```

Once landed, Phoenix removes its hand-staggered cron offsets (e.g. `23 */4` → `15 */4`) and lets the lock serialize.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Long-held locks starve short jobs | Same as today (busy_timeout). Group lock is FIFO, so starvation is bounded by queue depth, not unbounded. |
| Deadlock on multi-group skills | Sorted acquisition order (3.1). |
| Memory leak on the locks Map | GC on release when entry is the tail (3.1). |
| Worker crash mid-lock | In-process locks die with the worker — no recovery needed. Redis backend uses TTL + heartbeat. |
| Misuse: skill author over-declares groups, kills throughput | `nexaas doctor` surfaces high-wait groups. Cultural, not technical. |

## 7. Out of scope

- Cross-workspace locks (skills in workspace A serializing with skills in workspace B). YAGNI; workspaces are isolation units by design.
- Priority within a group ("stripe-billing-sync goes before failure-monitor"). Add later if needed; FIFO covers 95%.
- Distributed fairness across workers. Redis backend is naive SET-NX; if multi-worker fairness becomes a real ask, swap to Redlock or the BullMQ Pro group feature.

## 8. Rollout

1. Land `withGroups()` + manifest field behind no flag (it's opt-in by absence).
2. Phoenix declares `sqlite:data/onboarding.db` on the eight HR skills that touch it.
3. Watch one week of WAL `lock_acquired` events — confirm wait_ms p99 < 60s.
4. Document the convention in `skill-authoring.md` §X.
5. Phoenix removes the hand-staggered cron offsets.

## 9. Open questions

1. Should `nexaas register-skill` warn or **fail** on cron-overlap with same group? (Lean: warn — false positives are easy.)
2. Default lock acquire timeout? (Lean: 5 min, matches the pillar pipeline ceiling.)
3. Should an AI-skill's child agent calls inherit the parent's locks? (Lean: yes — implicit, same JS execution context.)
