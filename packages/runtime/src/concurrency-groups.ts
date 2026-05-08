/**
 * Skill concurrency groups — declarative mutex on shared resources.
 *
 * Skills that touch the same backing resource (a SQLite DB, a vendor rate
 * limit, a single-writer file) declare `concurrency_groups: [name]` in
 * their manifest. The worker acquires every declared group lock before
 * executing and releases all of them on completion or failure.
 *
 * Single-worker (default): in-process semaphore keyed on group name.
 * Multi-worker: replace with Redis SET-NX + heartbeat (see RFC #95).
 *
 * **Lock lifetime is bounded by the worker process.** Locks live in-memory
 * for the duration of the running worker — a clean shutdown or a crash
 * releases every held lock implicitly via process exit, so a stuck lock
 * cannot survive a restart. This is the right behavior for the single-
 * worker case but means lock state is not durable across restarts:
 * a skill mid-execution at shutdown does not "resume" holding the lock
 * when the worker comes back, and the next caller acquires fresh.
 * The phase-2 Redis backend (#97) will need explicit TTL + heartbeat
 * cleanup to provide the same guarantee in a multi-worker deployment.
 *
 * See docs/rfcs/0001-skill-concurrency-groups.md for design.
 */
import { appendWal } from "@nexaas/palace";

const locks = new Map<string, Promise<void>>();

export interface LockMeta {
  workspace?: string;
  skillId?: string;
  runId?: string;
}

/**
 * Run `fn` with the named groups held as a serial lock. Multi-group
 * acquisition uses sorted order to prevent deadlock between two skills
 * that declare overlapping groups in different orders.
 *
 * Skills with no groups bypass the semaphore entirely (no overhead).
 */
export async function withGroups<T>(
  groups: string[] | undefined,
  fn: () => Promise<T>,
  meta?: LockMeta,
): Promise<T> {
  if (!groups || groups.length === 0) return fn();

  const sorted = [...new Set(groups)].sort();
  const releases: Array<() => void> = [];

  for (const group of sorted) {
    const prev = locks.get(group) ?? Promise.resolve();
    let releaseThis!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseThis = resolve;
    });
    // Store `next` itself (not a chain) so the GC check on release can
    // identify whether we're still the tail.
    locks.set(group, next);

    const waitStart = Date.now();
    await prev;
    const waitMs = Date.now() - waitStart;

    if (meta?.workspace) {
      void appendWal({
        workspace: meta.workspace,
        op: "lock_acquired",
        actor: meta.skillId ? `skill:${meta.skillId}` : "concurrency-groups",
        payload: {
          group,
          run_id: meta.runId,
          skill_id: meta.skillId,
          wait_ms: waitMs,
        },
      }).catch(() => {
        /* WAL is best-effort — never block skill execution on observability */
      });
    }

    releases.push(() => {
      releaseThis();
      // GC: if we're the tail (no one queued behind us), drop the entry.
      if (locks.get(group) === next) locks.delete(group);
      if (meta?.workspace) {
        void appendWal({
          workspace: meta.workspace,
          op: "lock_released",
          actor: meta.skillId ? `skill:${meta.skillId}` : "concurrency-groups",
          payload: { group, run_id: meta.runId, skill_id: meta.skillId },
        }).catch(() => {});
      }
    });
  }

  try {
    return await fn();
  } finally {
    // Release in reverse order — symmetry with sorted acquire.
    for (const release of releases.reverse()) release();
  }
}

/** Test/diagnostic helper — exposes current lock holders. */
export function _activeGroups(): string[] {
  return Array.from(locks.keys());
}
