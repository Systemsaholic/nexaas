#!/usr/bin/env node
/**
 * Regression test for #86 Gap 2 — scheduler watchdog flags overdue
 * crons. Mocks BullMQ's `getJobSchedulers()` so no Redis is required.
 *
 * Run from repo root: `node --import tsx scripts/test-scheduler-watchdog-86.mjs`
 */

import { findOverdueCrons } from "../packages/runtime/src/tasks/scheduler-watchdog.ts";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

function fakeQueue(schedulers) {
  return { getJobSchedulers: async () => schedulers };
}

const NOW = new Date("2026-05-08T15:00:00Z").getTime();
const MIN = 60 * 1000;

// 1. Healthy schedulers (next in the future) → no overdue.
{
  const q = fakeQueue([
    { name: "cron-ops-fresh", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW + 5 * MIN,
      template: { data: { skillId: "ops/fresh" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 0, "healthy scheduler (next in future) → not overdue");
}

// 2. Slightly past expected next-fire (within grace) → not overdue.
{
  const q = fakeQueue([
    // next was 10 min ago; period is 15 min; 10 min < 2*15 = 30 min grace
    { name: "cron-ops-late", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW - 10 * MIN,
      template: { data: { skillId: "ops/within-grace" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 0, "10 min late on a 15-min cron (within 2× grace) → not overdue");
}

// 3. More than 2× period overdue → flagged.
{
  const q = fakeQueue([
    // next was 90 min ago; period is 15 min; 90 > 2*15 → overdue
    { name: "cron-ops-stale", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW - 90 * MIN,
      template: { data: { skillId: "ops/stale" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 1, "90 min late on a 15-min cron → overdue");
  assert(out[0].skillId === "ops/stale", "overdue includes correct skillId");
  assert(out[0].pattern === "*/15 * * * *", "overdue includes pattern");
  assert(out[0].lateByMs === 90 * MIN, `lateByMs = 90 min (got ${out[0].lateByMs / MIN} min)`);
}

// 4. Daily schedule overdue by ~50h → flagged (2× period for daily = 48h).
{
  const q = fakeQueue([
    { name: "cron-marketing", pattern: "0 13 * * *", tz: "America/New_York",
      next: NOW - 50 * 60 * MIN,
      template: { data: { skillId: "marketing/health-pipeline" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 1, "daily cron 50h overdue → flagged");
  assert(out[0].skillId === "marketing/health-pipeline",
    "Phoenix's missed marketing-health-pipeline scenario detected");
}

// 4b. Daily 25h overdue → NOT flagged (within 2× period grace for daily).
{
  const q = fakeQueue([
    { name: "cron-daily", pattern: "0 13 * * *", tz: "America/New_York",
      next: NOW - 25 * 60 * MIN,
      template: { data: { skillId: "ops/daily" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 0, "daily cron 25h late (within 48h grace) → not yet overdue");
}

// 5. Missing `next` → flagged immediately (active scheduler should always have it).
{
  const q = fakeQueue([
    { name: "cron-ops-broken", pattern: "*/15 * * * *", tz: "UTC",
      next: null,
      template: { data: { skillId: "ops/broken" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 1, "scheduler with null `next` → flagged");
}

// 6. Malformed pattern → silently skipped (no false alarm).
{
  const q = fakeQueue([
    { name: "cron-bad", pattern: "this is not cron", tz: "UTC",
      next: NOW - 100 * 24 * 60 * MIN,
      template: { data: { skillId: "ops/bad-pattern" } } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 0, "malformed pattern → silently skipped");
}

// 7. Scheduler missing skillId in data → silently skipped.
{
  const q = fakeQueue([
    { name: "cron-orphan", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW - 100 * MIN,
      template: { data: {} } },
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 0, "scheduler without skillId in data → skipped");
}

// 8. Stricter grace (graceMult=1) catches earlier.
{
  const q = fakeQueue([
    { name: "cron-ops", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW - 20 * MIN,
      template: { data: { skillId: "ops/x" } } },
  ]);
  const tight = await findOverdueCrons(q, 1, NOW);
  const loose = await findOverdueCrons(q, 2, NOW);
  assert(tight.length === 1, "graceMult=1 + 20 min late on 15 min cron → overdue");
  assert(loose.length === 0, "graceMult=2 + same → not yet overdue");
}

// 9. Mixed batch: only the overdue ones are returned.
{
  const q = fakeQueue([
    { name: "cron-ops-fresh", pattern: "*/5 * * * *", tz: "UTC",
      next: NOW + 2 * MIN,
      template: { data: { skillId: "ops/fresh" } } },
    { name: "cron-ops-stale", pattern: "*/15 * * * *", tz: "UTC",
      next: NOW - 90 * MIN,
      template: { data: { skillId: "ops/stale" } } },
    { name: "cron-ops-borderline", pattern: "0 * * * *", tz: "UTC",
      next: NOW - 30 * MIN,
      template: { data: { skillId: "ops/borderline-hourly" } } },  // 30 min late on hourly = within grace
  ]);
  const out = await findOverdueCrons(q, 2, NOW);
  assert(out.length === 1, "mixed batch → only the truly overdue one returned");
  assert(out[0].skillId === "ops/stale", "correct overdue skill identified");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
