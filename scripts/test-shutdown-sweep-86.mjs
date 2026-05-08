#!/usr/bin/env node
/**
 * Regression test for #86 Gap 3 — shutdown sweep marks in-flight skill_runs
 * as failed so silent-failure-watchdog (#69) can see them.
 *
 * Inserts skill_runs in every status, runs the sweep, asserts only `running`
 * rows for the test workspace are reset to `failed` with the expected
 * error_summary stamp. Other statuses, and other workspaces' running rows,
 * are untouched.
 *
 * Requires DATABASE_URL. Run from repo root:
 *   node --import tsx scripts/test-shutdown-sweep-86.mjs
 */

import { sql } from "@nexaas/palace";
import { sweepInFlightRuns } from "../packages/runtime/src/bullmq/worker.ts";

const WORKSPACE = `sweep-test-${Date.now()}-${process.pid}`;
const OTHER_WORKSPACE = `${WORKSPACE}-other`;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

async function fetchRow(workspace, runId) {
  const rows = await sql(
    `SELECT status, error_summary, completed_at, current_step
       FROM nexaas_memory.skill_runs
      WHERE workspace = $1 AND run_id = $2`,
    [workspace, runId],
  );
  return rows[0];
}

async function insertRun({ workspace, runId, status, currentStep, errorSummary, skillId }) {
  await sql(
    `INSERT INTO nexaas_memory.skill_runs
        (run_id, workspace, skill_id, trigger_type, status, current_step, error_summary)
     VALUES ($1, $2, $3, 'manual', $4, $5, $6)`,
    [runId, workspace, skillId ?? "test/sweep", status, currentStep ?? null, errorSummary ?? null],
  );
}

try {
  // Two `running` rows for the test workspace — both should be reset.
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000001", status: "running", currentStep: "step-A" });
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000002", status: "running", currentStep: null });
  // Other-status rows for the test workspace — must be untouched.
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000003", status: "waiting" });
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000004", status: "completed" });
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000005", status: "failed", errorSummary: "earlier failure" });
  await insertRun({ workspace: WORKSPACE, runId: "11111111-1111-1111-1111-000000000006", status: "escalated" });
  // Other-workspace `running` row — must be untouched (single-worker scope).
  await insertRun({ workspace: OTHER_WORKSPACE, runId: "11111111-1111-1111-1111-000000000007", status: "running", currentStep: "x" });

  const marked = await sweepInFlightRuns(WORKSPACE, "SIGTERM");
  assert(marked === 2, `marked count = 2 (got ${marked})`);

  const r1 = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000001");
  assert(r1?.status === "failed", "running row 1 → failed");
  assert(r1?.error_summary === "worker-exit-during-execution", "running row 1: error_summary stamped");
  assert(r1?.completed_at != null, "running row 1: completed_at set");

  const r2 = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000002");
  assert(r2?.status === "failed", "running row 2 (no current_step) → failed");

  const waiting = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000003");
  assert(waiting?.status === "waiting", "waiting row untouched");

  const completed = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000004");
  assert(completed?.status === "completed", "completed row untouched");

  const previouslyFailed = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000005");
  assert(previouslyFailed?.status === "failed", "previously-failed row stays failed");
  assert(previouslyFailed?.error_summary === "earlier failure", "previously-failed: error_summary preserved (sweep doesn't overwrite)");

  const escalated = await fetchRow(WORKSPACE, "11111111-1111-1111-1111-000000000006");
  assert(escalated?.status === "escalated", "escalated row untouched");

  const otherWs = await fetchRow(OTHER_WORKSPACE, "11111111-1111-1111-1111-000000000007");
  assert(otherWs?.status === "running", "other workspace's running row untouched (workspace scoping)");

  // Idempotency: second sweep should mark zero (all formerly-running rows
  // now have status='failed').
  const second = await sweepInFlightRuns(WORKSPACE, "SIGTERM");
  assert(second === 0, `second sweep is a no-op (got ${second})`);
} finally {
  // Clean up only this run's rows (workspace prefix is unique).
  await sql(
    `DELETE FROM nexaas_memory.skill_runs WHERE workspace IN ($1, $2)`,
    [WORKSPACE, OTHER_WORKSPACE],
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
