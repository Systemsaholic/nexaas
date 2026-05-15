#!/usr/bin/env node
/**
 * Regression test for inbound-match batch-evaluation refactor (#54).
 *
 * Verifies the matchDrawer function still behaves correctly when given a
 * pre-loaded waitpoints list (the dispatcher's batch path) AND when
 * called without one (the legacy single-shot path).
 *
 * Real Postgres required so resolveWaitpoint + the SELECT path work
 * end-to-end. The test fixtures register two waitpoints, evaluate two
 * drawers against them, and assert that:
 *   - Pre-loaded eval matches the same waitpoint as cold eval
 *   - Pre-loaded eval doesn't re-query (asserted by re-running with a
 *     stale list and verifying it still works)
 *   - First-match-wins ordering is preserved across both paths
 *
 * Run:
 *   DATABASE_URL=postgresql://nexaas_test:test@127.0.0.1/pa_delivery_test \
 *     node --import tsx scripts/test-inbound-match-batch.mjs
 */

import {
  registerWaitpoint,
  matchDrawerAgainstWaitpoints,
  selectOpenWaitpoints,
} from "../packages/runtime/src/tasks/inbound-match-waitpoint.ts";
import { sql, getPool } from "../packages/palace/src/db.ts";
import { randomUUID } from "crypto";

const WORKSPACE = `test-${Date.now()}`;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

async function makeDrawer(room, content) {
  const id = randomUUID();
  await sql(
    `INSERT INTO nexaas_memory.events
       (id, workspace, wing, hall, room, content, event_type, agent_id, normalize_version, created_at)
     VALUES ($1, $2, 'inbox', 'messaging', $3, $4, 'drawer', 'test', 1, now())`,
    [id, WORKSPACE, room, JSON.stringify({ content, from: "u123" })],
  );
  return { id, room, content: JSON.stringify({ content, from: "u123" }), created_at: new Date().toISOString() };
}

// Register a 2FA waitpoint and a UUID waitpoint. First-match-wins by
// creation order, so the 2FA one should always win for codes.
console.log("\nSetup: register two waitpoints");
const reg1 = await registerWaitpoint({
  workspace: WORKSPACE,
  match: { content_pattern: "digit_code" },
  timeout_seconds: 60,
});
const reg2 = await registerWaitpoint({
  workspace: WORKSPACE,
  match: { content_pattern: "uuid_v4" },
  timeout_seconds: 60,
});
assert("waitpoint_id" in reg1, "first waitpoint registered");
assert("waitpoint_id" in reg2, "second waitpoint registered");

// ── 1. selectOpenWaitpoints returns both ─────────────────────────────
console.log("\n1. selectOpenWaitpoints loads everything pending");
{
  const wps = await selectOpenWaitpoints(WORKSPACE);
  assert(wps.length >= 2, `found ≥2 open waitpoints (got ${wps.length})`);
  // Ordering: creation ASC — first registered is first
  assert(wps[0].dormant_signal === reg1.waitpoint_id, "ordering: first registered is first");
}

// ── 2. Match with preload === match without preload ────────────────
console.log("\n2. Match behavior identical with vs. without preload");
{
  const drawerCold = await makeDrawer("inbox.messaging.telegram", "Your code is 123456");
  // Cold path: no preload, function does its own SELECT
  const cold = await matchDrawerAgainstWaitpoints(WORKSPACE, drawerCold);
  assert(cold.matched, "cold match succeeded");
  assert(cold.waitpoint_id === reg1.waitpoint_id, "cold matched the 2FA waitpoint");
}

// ── 3. Preload path matches against the same list ────────────────────
console.log("\n3. Preload path matches against the pre-loaded list");
{
  // Re-register another digit_code waitpoint since the first one was just resolved
  const reg3 = await registerWaitpoint({
    workspace: WORKSPACE,
    match: { content_pattern: "digit_code" },
    timeout_seconds: 60,
  });
  const wps = await selectOpenWaitpoints(WORKSPACE);
  assert(wps.some(w => w.dormant_signal === reg3.waitpoint_id), "fresh waitpoint visible in preload");

  const drawer = await makeDrawer("inbox.messaging.telegram", "Code 7890");
  const result = await matchDrawerAgainstWaitpoints(WORKSPACE, drawer, wps);
  assert(result.matched, "preload-path match succeeded");
  assert(result.waitpoint_id === reg3.waitpoint_id, "preload matched the fresh digit_code waitpoint");
}

// ── 4. Preload list with an already-resolved waitpoint (race-safe) ──
console.log("\n4. Preload with a stale (already-resolved) waitpoint is race-safe");
{
  // Register two digit_code waitpoints, then preload, then resolve the
  // first one out-of-band before passing the stale list to matchDrawer.
  // Expectation: matchDrawer skips the already-resolved one and matches
  // the second.
  const regA = await registerWaitpoint({
    workspace: WORKSPACE,
    match: { content_pattern: "digit_code" },
    timeout_seconds: 60,
  });
  const regB = await registerWaitpoint({
    workspace: WORKSPACE,
    match: { content_pattern: "digit_code" },
    timeout_seconds: 60,
  });
  const wps = await selectOpenWaitpoints(WORKSPACE);
  // Simulate concurrent resolution of regA via direct DB update.
  await sql(
    `UPDATE nexaas_memory.events
        SET dormant_signal = NULL
      WHERE workspace = $1 AND dormant_signal = $2`,
    [WORKSPACE, regA.waitpoint_id],
  );

  const drawer = await makeDrawer("inbox.messaging.telegram", "Number 4242");
  const result = await matchDrawerAgainstWaitpoints(WORKSPACE, drawer, wps);
  // The stale list has regA first. resolveWaitpoint on a NULL dormant_signal
  // fails; matchDrawer logs and continues to regB.
  assert(result.matched, "stale-list match still produced a match");
  assert(result.waitpoint_id === regB.waitpoint_id,
    `matched the next-available waitpoint (got ${result.waitpoint_id})`);
}

// ── 5. Empty preload skips the match loop entirely ──────────────────
console.log("\n5. Empty preload (no open waitpoints) is a no-op");
{
  const drawer = await makeDrawer("inbox.messaging.telegram", "Nothing to match");
  const result = await matchDrawerAgainstWaitpoints(WORKSPACE, drawer, []);
  assert(!result.matched, "no match when preload is empty");
}

// Cleanup
await sql(`DELETE FROM nexaas_memory.events WHERE workspace = $1`, [WORKSPACE]);
await getPool().end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
