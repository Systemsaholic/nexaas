#!/usr/bin/env node
/**
 * Regression test for #94 — stuck-`claimed` rows after worker restart.
 *
 * Inserts representative rows into notification_dispatches, runs the
 * reaper, and verifies only the stale-`claimed` row is reset to `failed`
 * with the reaper message. Fresh claims, delivered rows, and already-
 * failed rows must be untouched.
 *
 * Requires DATABASE_URL pointing at a Nexaas-bootstrapped Postgres.
 * Run from repo root: `node scripts/test-stale-claim-reaper-94.mjs`
 * Cleanup at end removes only this run's rows.
 */

import { sql } from "@nexaas/palace";
import { _reapStaleClaims } from "@nexaas/runtime/tasks/notification-dispatcher";

const WORKSPACE = `reaper-test-${Date.now()}-${process.pid}`;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`OK    ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}`);
    fail++;
  }
}

async function fetchRow(idemKey) {
  const rows = await sql(
    `SELECT status, last_error
       FROM nexaas_memory.notification_dispatches
      WHERE workspace = $1 AND idempotency_key = $2`,
    [WORKSPACE, idemKey],
  );
  return rows[0];
}

async function insertRow({ idemKey, status, claimedAtOffsetMin, lastError }) {
  await sql(
    `INSERT INTO nexaas_memory.notification_dispatches
        (workspace, idempotency_key, channel_role, status, attempts,
         claimed_at, last_error)
     VALUES ($1, $2, 'test_role', $3, 1,
             now() + ($4 || ' minutes')::interval, $5)`,
    [WORKSPACE, idemKey, status, String(claimedAtOffsetMin), lastError ?? null],
  );
}

try {
  // Setup: four representative rows.
  await insertRow({ idemKey: "stale-claim",   status: "claimed",   claimedAtOffsetMin: -5,  lastError: null });
  await insertRow({ idemKey: "fresh-claim",   status: "claimed",   claimedAtOffsetMin: -1,  lastError: null });   // -1min < 2min threshold → not eligible
  await insertRow({ idemKey: "borderline",    status: "claimed",   claimedAtOffsetMin: -3,  lastError: null });
  await insertRow({ idemKey: "delivered-row", status: "delivered", claimedAtOffsetMin: -10, lastError: null });
  await insertRow({ idemKey: "failed-row",    status: "failed",    claimedAtOffsetMin: -10, lastError: "earlier failure" });

  // Run the reaper.
  const reaped = await _reapStaleClaims(WORKSPACE);
  assert(reaped === 2, `reaped count = 2 (stale-claim + borderline), got ${reaped}`);

  // Assert each row's post-state.
  const stale = await fetchRow("stale-claim");
  assert(stale?.status === "failed", "stale-claim: status now 'failed'");
  assert(
    typeof stale?.last_error === "string" && stale.last_error.startsWith("reaped:"),
    "stale-claim: last_error has reaper marker",
  );

  const borderline = await fetchRow("borderline");
  assert(borderline?.status === "failed", "borderline (3min old): also reaped");

  const fresh = await fetchRow("fresh-claim");
  assert(fresh?.status === "claimed", "fresh-claim (1min old): still claimed (under threshold)");
  assert(fresh?.last_error === null, "fresh-claim: last_error untouched");

  const delivered = await fetchRow("delivered-row");
  assert(delivered?.status === "delivered", "delivered-row: still delivered (wrong status for reaper)");

  const previouslyFailed = await fetchRow("failed-row");
  assert(previouslyFailed?.status === "failed", "failed-row: still failed");
  assert(previouslyFailed?.last_error === "earlier failure", "failed-row: last_error preserved (reaper used COALESCE)");

  // Idempotency: running again should reap nothing (no claimed rows left).
  const secondRun = await _reapStaleClaims(WORKSPACE);
  assert(secondRun === 0, "second sweep is a no-op");
} finally {
  // Cleanup — remove this run's rows regardless of pass/fail.
  await sql(
    `DELETE FROM nexaas_memory.notification_dispatches WHERE workspace = $1`,
    [WORKSPACE],
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
