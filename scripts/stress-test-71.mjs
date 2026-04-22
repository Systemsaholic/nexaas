#!/usr/bin/env node
/**
 * Stress test for #71 — concurrent appendWal should not fork the chain.
 *
 * Fires N parallel appendWal calls against a dedicated test workspace
 * and verifies every resulting row has a distinct prev_hash. Under the
 * pre-fix race, ~2% of rows in Phoenix WAL shared a prev_hash. With the
 * advisory-lock fix, the fork rate should be 0 even under tight concurrency.
 *
 * Run on a VPS that has Nexaas checked out: `node scripts/stress-test-71.mjs`.
 * Cleanup at end removes the test workspace's rows.
 */

import { appendWal, sql } from "@nexaas/palace";

const WORKSPACE = `race-test-${Date.now()}-${process.pid}`;
const N = 50;

console.log(`[71] stress test: ${N} concurrent appendWal calls on workspace=${WORKSPACE}`);

const start = Date.now();
await Promise.all(
  Array.from({ length: N }, (_, i) =>
    appendWal({
      workspace: WORKSPACE,
      op: "race_test",
      actor: "stress-test-71",
      payload: { i, fired_at: Date.now() },
    }),
  ),
);
const elapsed = Date.now() - start;
console.log(`[71] ${N} writes completed in ${elapsed}ms (${(elapsed/N).toFixed(1)}ms/write)`);

const [stats] = await sql(
  `SELECT count(*)::int AS total,
          count(DISTINCT prev_hash)::int AS distinct_prev,
          count(DISTINCT hash)::int AS distinct_hash
   FROM nexaas_memory.wal WHERE workspace = $1`,
  [WORKSPACE],
);

console.log(`[71] total=${stats.total}  distinct_prev=${stats.distinct_prev}  distinct_hash=${stats.distinct_hash}`);

const forks = stats.total - stats.distinct_prev;
if (forks === 0 && stats.distinct_hash === stats.total) {
  console.log(`[71] PASS — no forks, all hashes distinct`);
} else {
  console.log(`[71] FAIL — ${forks} forked rows`);
}

await sql(`DELETE FROM nexaas_memory.wal WHERE workspace = $1`, [WORKSPACE]);
console.log(`[71] cleanup: removed ${N} test rows`);

process.exit(forks === 0 ? 0 : 1);
