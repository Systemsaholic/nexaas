/**
 * `nexaas doctor locks` — concurrency-group lock-contention report (#98).
 *
 * Reads the `lock_acquired` / `lock_released` WAL events emitted by
 * `withGroups()` (#95 / #96) and computes per-group contention stats:
 * acquire count, p50/p99 wait_ms, top blocked-on skill, top blocking
 * skill (held the lock longest on average), and a one-line suggestion
 * when a group looks pathological.
 *
 * Read-only. The whole purpose of the WAL events is contention surfacing;
 * this command is the consumer. Phase-2 surfaces (Bull Board widget,
 * dashboard panel) can layer on the same data without changing this CLI.
 */

import { sql, createPool } from "@nexaas/palace";

interface LockAcquiredRow {
  group: string;
  skill_id: string | null;
  run_id: string | null;
  wait_ms: number;
  acquired_at: string;
}

interface LockReleasedRow {
  group: string;
  skill_id: string | null;
  run_id: string | null;
  released_at: string;
}

interface GroupStats {
  group: string;
  acquires: number;
  uniqueSkills: Set<string>;
  waitMs: number[];
  topBlocked: { skillId: string; maxWaitMs: number };
  holdMsBySkill: Map<string, number[]>;
}

const USAGE = `\
Usage: nexaas doctor locks [--since <duration>] [--group <name>] [--limit <n>]

Concurrency-group lock contention report. Reads lock_acquired /
lock_released WAL events emitted by skills that declare
concurrency_groups (#95 / #96).

Options:
  --since <duration>    Window to analyze. Accepts e.g. 24h, 1h, 7d, 30m.
                        Default: 24h.
  --group <name>        Filter to a single group (substring match).
  --limit <n>           Show at most N groups (most contended first).
                        Default: 10.

Required env: NEXAAS_WORKSPACE
`;

function parseSince(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]) {
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default:  return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/**
 * Build per-group stats from acquired + released event streams.
 *
 * Acquires carry the wait_ms directly. Hold-time is paired by
 * (workspace, skill_id, run_id, group) — `withGroups()`'s lockMeta
 * always supplies these three when the workspace is set, so the pair
 * is deterministic when both events landed. Acquires without a
 * matching release (worker died mid-skill, lost its release event)
 * are still counted toward the wait stats but contribute no hold
 * time — graceful degradation for the failure mode #86 Gap 3 fixes.
 *
 * Exported for the regression test (#98 test); not part of the
 * runtime's public surface.
 */
export function buildStats(
  acquired: LockAcquiredRow[],
  released: LockReleasedRow[],
): Map<string, GroupStats> {
  const byGroup = new Map<string, GroupStats>();

  for (const r of acquired) {
    let stats = byGroup.get(r.group);
    if (!stats) {
      stats = {
        group: r.group,
        acquires: 0,
        uniqueSkills: new Set(),
        waitMs: [],
        topBlocked: { skillId: r.skill_id ?? "(unknown)", maxWaitMs: 0 },
        holdMsBySkill: new Map(),
      };
      byGroup.set(r.group, stats);
    }
    stats.acquires++;
    if (r.skill_id) stats.uniqueSkills.add(r.skill_id);
    stats.waitMs.push(r.wait_ms);
    if (r.wait_ms > stats.topBlocked.maxWaitMs) {
      stats.topBlocked = { skillId: r.skill_id ?? "(unknown)", maxWaitMs: r.wait_ms };
    }
  }

  // Pair acquired ↔ released by (group, skill_id, run_id) for hold time.
  // Use a multi-map keyed on the same triple so duplicates handle correctly.
  const acquiredByKey = new Map<string, number>();   // key → acquired_at ms
  for (const r of acquired) {
    if (!r.skill_id || !r.run_id) continue;
    acquiredByKey.set(`${r.group}|${r.skill_id}|${r.run_id}`, Date.parse(r.acquired_at));
  }
  for (const r of released) {
    if (!r.skill_id || !r.run_id) continue;
    const key = `${r.group}|${r.skill_id}|${r.run_id}`;
    const acquiredAt = acquiredByKey.get(key);
    if (acquiredAt === undefined) continue;
    const holdMs = Date.parse(r.released_at) - acquiredAt;
    if (!Number.isFinite(holdMs) || holdMs < 0) continue;

    const stats = byGroup.get(r.group);
    if (!stats) continue;
    const list = stats.holdMsBySkill.get(r.skill_id) ?? [];
    list.push(holdMs);
    stats.holdMsBySkill.set(r.skill_id, list);
  }

  return byGroup;
}

function suggestion(stats: GroupStats): string | null {
  const sorted = [...stats.waitMs].sort((a, b) => a - b);
  const p99 = percentile(sorted, 99);
  if (p99 < 5_000) return null;

  // Find top blocker (skill that held the lock longest on average).
  let topBlockerId: string | null = null;
  let topBlockerAvg = 0;
  for (const [skillId, holds] of stats.holdMsBySkill) {
    if (holds.length === 0) continue;
    const avg = holds.reduce((a, b) => a + b, 0) / holds.length;
    if (avg > topBlockerAvg) { topBlockerAvg = avg; topBlockerId = skillId; }
  }
  if (!topBlockerId) return null;

  return (
    `${stats.topBlocked.skillId} waited ${fmtMs(stats.topBlocked.maxWaitMs)} ` +
    `on '${stats.group}' (held by ${topBlockerId}, ` +
    `avg hold ${fmtMs(topBlockerAvg)}) — consider splitting ${topBlockerId} ` +
    `or moving ${stats.topBlocked.skillId} off the same minute.`
  );
}

export async function runLocks(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  let sinceMs = 24 * 60 * 60 * 1000;
  let groupFilter: string | null = null;
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) {
      const parsed = parseSince(args[++i]);
      if (parsed === null) {
        console.error(`Invalid --since: ${args[i]}. Examples: 24h, 1h, 7d, 30m`);
        process.exit(1);
      }
      sinceMs = parsed;
    } else if (args[i] === "--group" && args[i + 1]) {
      groupFilter = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    }
  }

  createPool();
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();

  const [acquired, released] = await Promise.all([
    sql<LockAcquiredRow>(
      `SELECT
         payload->>'group' AS "group",
         payload->>'skill_id' AS skill_id,
         payload->>'run_id' AS run_id,
         COALESCE((payload->>'wait_ms')::int, 0) AS wait_ms,
         created_at::text AS acquired_at
       FROM nexaas_memory.wal
       WHERE workspace = $1
         AND op = 'lock_acquired'
         AND created_at >= $2::timestamptz`,
      [workspace, sinceIso],
    ),
    sql<LockReleasedRow>(
      `SELECT
         payload->>'group' AS "group",
         payload->>'skill_id' AS skill_id,
         payload->>'run_id' AS run_id,
         created_at::text AS released_at
       FROM nexaas_memory.wal
       WHERE workspace = $1
         AND op = 'lock_released'
         AND created_at >= $2::timestamptz`,
      [workspace, sinceIso],
    ),
  ]);

  const byGroup = buildStats(acquired, released);
  if (byGroup.size === 0) {
    console.log(
      `No lock_acquired events for workspace=${workspace} in the last ${fmtMs(sinceMs)}.`,
    );
    if (acquired.length === 0) {
      console.log("Either no skills declare concurrency_groups, or none have run in this window.");
    }
    return;
  }

  // Sort by p99 wait_ms descending (most pathological first).
  const ranked = [...byGroup.values()]
    .filter((g) => groupFilter === null || g.group.includes(groupFilter))
    .map((g) => {
      const sorted = [...g.waitMs].sort((a, b) => a - b);
      return {
        ...g,
        sorted,
        p50: percentile(sorted, 50),
        p99: percentile(sorted, 99),
      };
    })
    .sort((a, b) => b.p99 - a.p99)
    .slice(0, limit);

  console.log(
    `\nLock contention for workspace=${workspace} over the last ${fmtMs(sinceMs)} ` +
    `(${ranked.length} group${ranked.length === 1 ? "" : "s"} shown):\n`,
  );
  for (const g of ranked) {
    console.log(`Group: ${g.group}`);
    console.log(`  Acquires: ${g.acquires} (${g.uniqueSkills.size} skill${g.uniqueSkills.size === 1 ? "" : "s"})`);
    console.log(`  Wait p50: ${fmtMs(g.p50)} | p99: ${fmtMs(g.p99)}`);
    console.log(`  Top blocked-on: ${g.topBlocked.skillId} (${fmtMs(g.topBlocked.maxWaitMs)} wait)`);

    let topBlockerLine = "Top blocker:    (no released events paired)";
    let maxAvg = 0;
    let topId: string | null = null;
    for (const [skillId, holds] of g.holdMsBySkill) {
      const avg = holds.reduce((a, b) => a + b, 0) / holds.length;
      if (avg > maxAvg) { maxAvg = avg; topId = skillId; }
    }
    if (topId) {
      topBlockerLine = `Top blocker:    ${topId} (held lock ${fmtMs(maxAvg)} avg)`;
    }
    console.log(`  ${topBlockerLine}`);

    const hint = suggestion(g);
    if (hint) console.log(`  Suggestion: ${hint}`);
    console.log();
  }
}
