#!/usr/bin/env node
/**
 * Regression test for #98 — `nexaas doctor locks` stats builder.
 *
 * Exercises buildStats() with synthetic acquired+released event streams.
 * Pure function, no DB required.
 *
 * Run from repo root: `node --import tsx scripts/test-doctor-locks-98.mjs`
 */

import { buildStats } from "../packages/cli/src/doctor-locks.ts";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

// Helper: build matched acquired+released pair.
function pair(group, skillId, runId, acquiredAt, waitMs, holdMs) {
  return {
    acquired: { group, skill_id: skillId, run_id: runId, wait_ms: waitMs, acquired_at: acquiredAt },
    released: { group, skill_id: skillId, run_id: runId, released_at: new Date(Date.parse(acquiredAt) + holdMs).toISOString() },
  };
}

// 1. Empty input → empty map.
{
  const stats = buildStats([], []);
  assert(stats.size === 0, "empty input → empty map");
}

// 2. Single group with two acquires → stats correct.
{
  const acq = [
    { group: "g1", skill_id: "ops/a", run_id: "r1", wait_ms: 100, acquired_at: "2026-05-08T15:00:00.000Z" },
    { group: "g1", skill_id: "ops/b", run_id: "r2", wait_ms: 5000, acquired_at: "2026-05-08T15:00:01.000Z" },
  ];
  const rel = [
    { group: "g1", skill_id: "ops/a", run_id: "r1", released_at: "2026-05-08T15:00:00.500Z" },
    { group: "g1", skill_id: "ops/b", run_id: "r2", released_at: "2026-05-08T15:00:11.000Z" },
  ];
  const stats = buildStats(acq, rel);
  const g1 = stats.get("g1");
  assert(g1?.acquires === 2, "acquires count = 2");
  assert(g1?.uniqueSkills.size === 2, "unique skill count = 2");
  assert(g1?.waitMs.length === 2, "waitMs collected for both acquires");
  assert(g1?.topBlocked.skillId === "ops/b", "top blocked = the longest wait skill");
  assert(g1?.topBlocked.maxWaitMs === 5000, "top blocked wait_ms recorded");
  assert(g1?.holdMsBySkill.get("ops/a")?.[0] === 500, "ops/a hold = 500ms");
  assert(g1?.holdMsBySkill.get("ops/b")?.[0] === 10000, "ops/b hold = 10000ms");
}

// 3. Acquired without matching released (worker died mid-skill) → wait counted, no hold.
{
  const acq = [
    { group: "g2", skill_id: "ops/dead", run_id: "r3", wait_ms: 200, acquired_at: "2026-05-08T15:00:00.000Z" },
  ];
  const rel = [];   // worker exited before release fired
  const stats = buildStats(acq, rel);
  const g2 = stats.get("g2");
  assert(g2?.acquires === 1, "orphan acquire still counted toward acquires");
  assert(g2?.waitMs[0] === 200, "wait_ms still collected");
  assert(g2?.holdMsBySkill.size === 0, "no hold recorded for orphan");
}

// 4. Released without matching acquired (cross-worker race or stale event) → ignored.
{
  const acq = [];
  const rel = [
    { group: "g3", skill_id: "ops/x", run_id: "r4", released_at: "2026-05-08T15:00:00.000Z" },
  ];
  const stats = buildStats(acq, rel);
  assert(stats.size === 0, "released-only event → no group stats created");
}

// 5. Multiple acquires for same skill on the same group.
{
  const p1 = pair("g4", "ops/repeat", "r-1", "2026-05-08T15:00:00.000Z", 100, 1000);
  const p2 = pair("g4", "ops/repeat", "r-2", "2026-05-08T15:01:00.000Z", 250, 2000);
  const stats = buildStats([p1.acquired, p2.acquired], [p1.released, p2.released]);
  const g4 = stats.get("g4");
  assert(g4?.acquires === 2, "same skill 2 acquires");
  assert(g4?.uniqueSkills.size === 1, "but only 1 unique skill");
  const holds = g4?.holdMsBySkill.get("ops/repeat") ?? [];
  assert(holds.length === 2, "both holds recorded");
  assert(holds.includes(1000) && holds.includes(2000), "both hold values present");
}

// 6. Multiple groups in one input → independently aggregated.
{
  const a = pair("g5", "skill/a", "ra", "2026-05-08T15:00:00.000Z", 100, 500);
  const b = pair("g6", "skill/b", "rb", "2026-05-08T15:00:00.000Z", 200, 1000);
  const stats = buildStats([a.acquired, b.acquired], [a.released, b.released]);
  assert(stats.size === 2, "two groups");
  assert(stats.get("g5")?.uniqueSkills.has("skill/a"), "g5 has skill/a");
  assert(stats.get("g6")?.uniqueSkills.has("skill/b"), "g6 has skill/b");
  assert(!stats.get("g5")?.uniqueSkills.has("skill/b"), "g5 doesn't have skill/b");
}

// 7. Skill-id null on event → skipped from pairing but counted as acquire.
{
  const acq = [
    { group: "g7", skill_id: null, run_id: null, wait_ms: 50, acquired_at: "2026-05-08T15:00:00.000Z" },
    { group: "g7", skill_id: "ops/known", run_id: "r1", wait_ms: 100, acquired_at: "2026-05-08T15:00:00.000Z" },
  ];
  const rel = [
    { group: "g7", skill_id: "ops/known", run_id: "r1", released_at: "2026-05-08T15:00:01.000Z" },
  ];
  const stats = buildStats(acq, rel);
  const g7 = stats.get("g7");
  assert(g7?.acquires === 2, "both acquires counted (including the null-skill one)");
  assert(g7?.uniqueSkills.size === 1, "unique skills only counts non-null skill_ids");
  assert(g7?.holdMsBySkill.size === 1, "only the paired one has hold time");
}

// 8. Released with mismatched run_id → not paired.
{
  const acq = [
    { group: "g8", skill_id: "ops/x", run_id: "r-orig", wait_ms: 0, acquired_at: "2026-05-08T15:00:00.000Z" },
  ];
  const rel = [
    { group: "g8", skill_id: "ops/x", run_id: "r-different", released_at: "2026-05-08T15:00:01.000Z" },
  ];
  const stats = buildStats(acq, rel);
  const g8 = stats.get("g8");
  assert(g8?.holdMsBySkill.size === 0, "mismatched run_id → no hold recorded");
}

// 9. Released BEFORE acquired (clock skew, retroactive event) → discarded as negative hold.
{
  const acq = [
    { group: "g9", skill_id: "ops/x", run_id: "r1", wait_ms: 10, acquired_at: "2026-05-08T15:00:01.000Z" },
  ];
  const rel = [
    { group: "g9", skill_id: "ops/x", run_id: "r1", released_at: "2026-05-08T15:00:00.000Z" },  // -1000ms
  ];
  const stats = buildStats(acq, rel);
  const g9 = stats.get("g9");
  assert(g9?.holdMsBySkill.size === 0, "negative hold (clock-skew) → discarded");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
