#!/usr/bin/env -S npx tsx
// Smoke test for RFC #95 skill concurrency groups.
// Run: npx tsx scripts/test-concurrency-groups.mjs
//
// Verifies:
//  1. Empty groups → bypass (no serialization, no overhead)
//  2. Single shared group → two callers serialize FIFO
//  3. Two groups, opposite declaration order → no deadlock
//  4. Lock released when the wrapped fn throws

import { withGroups, _activeGroups } from "../packages/runtime/src/concurrency-groups.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];
const tag = (s) => log.push(`${(Date.now() - t0).toString().padStart(4)}ms ${s}`);
const t0 = Date.now();

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    console.error(log.join("\n"));
    process.exit(1);
  }
}

// 1. Empty groups bypass
{
  let ran = false;
  await withGroups([], async () => {
    ran = true;
  });
  assert(ran, "empty groups should still execute fn");
  assert(_activeGroups().length === 0, "no locks held after empty-groups call");
}

// 2. Single shared group serializes
{
  const A = withGroups(["g1"], async () => {
    tag("A start");
    await sleep(50);
    tag("A end");
  });
  const B = withGroups(["g1"], async () => {
    tag("B start");
    await sleep(50);
    tag("B end");
  });
  await Promise.all([A, B]);
  // A must fully complete before B starts
  const aEnd = log.findIndex((l) => l.includes("A end"));
  const bStart = log.findIndex((l) => l.includes("B start"));
  assert(aEnd < bStart, "B started before A ended — group did not serialize");
  assert(_activeGroups().length === 0, "locks leaked after single-group test");
}

// 3. Multi-group, opposite declaration order — no deadlock
{
  log.length = 0;
  const X = withGroups(["alpha", "beta"], async () => {
    tag("X work");
    await sleep(40);
  });
  const Y = withGroups(["beta", "alpha"], async () => {
    tag("Y work");
    await sleep(40);
  });
  // Race ends if both complete; deadlock would hang past 5s.
  const winner = await Promise.race([
    Promise.all([X, Y]).then(() => "ok"),
    sleep(5000).then(() => "deadlock"),
  ]);
  assert(winner === "ok", "two skills with opposite group declaration order deadlocked");
  assert(_activeGroups().length === 0, "locks leaked after multi-group test");
}

// 4. Release on throw
{
  try {
    await withGroups(["throwy"], async () => {
      throw new Error("intentional");
    });
  } catch {
    /* expected */
  }
  let ranAfter = false;
  await withGroups(["throwy"], async () => {
    ranAfter = true;
  });
  assert(ranAfter, "lock not released after fn threw — next caller starved");
  assert(_activeGroups().length === 0, "locks leaked after throw");
}

console.log("OK — all 4 cases passed");
console.log(log.join("\n"));
