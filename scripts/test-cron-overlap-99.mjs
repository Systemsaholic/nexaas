#!/usr/bin/env node
/**
 * Regression test for #99 — register-skill warns on cron-overlap within
 * a shared concurrency_group. Mocks BullMQ's `getJobSchedulers()` to
 * inject controlled scenarios; no Redis or DB required.
 *
 * Run from repo root: `node --import tsx scripts/test-cron-overlap-99.mjs`
 */

import { findCronOverlaps } from "../packages/cli/src/register-skill.ts";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

function fakeQueue(schedulers) {
  return { getJobSchedulers: async () => schedulers };
}

// 1. New skill with no groups → no warnings, regardless of existing schedulers.
{
  const q = fakeQueue([
    { name: "cron-other", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/other", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: [], triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 0, "no groups → no warnings");
}

// 2. New skill with no triggers → no warnings.
{
  const q = fakeQueue([
    { name: "cron-other", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/other", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, { id: "ops/new", groups: ["g1"], triggers: [] });
  assert(w.length === 0, "no triggers → no warnings");
}

// 3. Same group + overlapping cron → warning.
{
  const q = fakeQueue([
    { name: "cron-ops-engagement", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/engagement", concurrencyGroups: ["sqlite:onb"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["sqlite:onb"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 1, "same group + same cron → 1 warning");
  assert(w[0].group === "sqlite:onb", "warning carries the group name");
  assert(w[0].newPattern === "*/15 * * * *", "warning carries the new pattern");
  assert(w[0].conflicts.length === 1, "warning lists 1 conflict");
  assert(w[0].conflicts[0].skillId === "ops/engagement", "conflict identifies the existing skill");
  assert(w[0].conflicts[0].pattern === "*/15 * * * *", "conflict carries the existing pattern");
}

// 4. Same group + non-overlapping cron → no warning.
{
  const q = fakeQueue([
    { name: "cron-ops-engagement", pattern: "0 9 * * *", tz: "UTC",  // daily 9am
      template: { data: { skillId: "ops/engagement", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["g1"],
    triggers: [{ pattern: "0 17 * * *", tz: "UTC" }],   // daily 5pm
  });
  assert(w.length === 0, "same group, non-overlapping cron → no warning");
}

// 5. Different group + same cron → no warning.
{
  const q = fakeQueue([
    { name: "cron-ops-engagement", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/engagement", concurrencyGroups: ["other"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["sqlite:onb"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 0, "different group → no warning even with same cron");
}

// 6. Existing scheduler without concurrencyGroups in data → silently skipped.
{
  const q = fakeQueue([
    { name: "cron-legacy", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/legacy" /* no concurrencyGroups */ } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["g1"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 0, "scheduler missing concurrencyGroups → skipped (legacy)");
}

// 7. Re-registering the same skill (own job name) → not flagged against itself.
{
  const q = fakeQueue([
    { name: "cron-ops-new", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/new", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["g1"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 0, "re-registering same skill → no self-warning");
}

// 8. Multiple skills on same group with overlapping cron → all listed under one warning.
{
  const q = fakeQueue([
    { name: "cron-ops-engagement", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/engagement", concurrencyGroups: ["sqlite:onb"] } } },
    { name: "cron-ops-failure-monitor", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/failure-monitor", concurrencyGroups: ["sqlite:onb"] } } },
    { name: "cron-ops-unrelated", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/unrelated", concurrencyGroups: ["other-group"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["sqlite:onb"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 1, "multi-conflict → still 1 warning per group");
  assert(w[0].conflicts.length === 2, "warning lists both conflicting skills");
  const ids = new Set(w[0].conflicts.map((c) => c.skillId));
  assert(ids.has("ops/engagement") && ids.has("ops/failure-monitor"),
    "warning includes engagement + failure-monitor");
  assert(!ids.has("ops/unrelated"), "warning does not include unrelated-group skill");
}

// 9. Skill with multiple groups, conflict on only one → only that group warns.
{
  const q = fakeQueue([
    { name: "cron-ops-engagement", pattern: "*/15 * * * *", tz: "UTC",
      template: { data: { skillId: "ops/engagement", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["g1", "g2"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 1, "1 warning when only one of new skill's groups conflicts");
  assert(w[0].group === "g1", "warning is for the conflicting group only");
}

// 10. Malformed cron pattern → silently skipped (no throw).
{
  const q = fakeQueue([
    { name: "cron-bad", pattern: "this is not cron", tz: "UTC",
      template: { data: { skillId: "ops/bad", concurrencyGroups: ["g1"] } } },
  ]);
  const w = await findCronOverlaps(q, {
    id: "ops/new", groups: ["g1"],
    triggers: [{ pattern: "*/15 * * * *", tz: "UTC" }],
  });
  assert(w.length === 0, "malformed existing cron → no throw, no warning");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
