#!/usr/bin/env node
/**
 * Integration test for #122 Wave 1 — upsertPaThreads idempotency + paused state.
 *
 * Exercises the DB-touching half of Wave 1 §1.2 against a real Postgres.
 * Requires DATABASE_URL pointing at a database with migration 020 applied.
 *
 * Run:
 *   DATABASE_URL=postgresql://.../pa_threads_test \
 *     node --import tsx scripts/test-pa-upsert-122.mjs
 */

import {
  upsertPaThreads,
} from "../packages/runtime/src/schemas/persona-profile.ts";
import { sql, getPool } from "../packages/palace/src/db.ts";

const WORKSPACE = "test-workspace";
const USER = "alice";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// Clean slate.
await sql(`DELETE FROM nexaas_memory.pa_threads WHERE workspace = $1`, [WORKSPACE]);

// ── 1. First insert ───────────────────────────────────────────────
console.log("\n1. First registration adds rows");
{
  const profile = {
    threads: [
      { id: "hr", display: "👥 HR", domain_aliases: ["hr", "onboarding"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.added.length === 2, `2 threads added (got ${summary.added.length})`);
  assert(summary.unchanged.length === 0, "0 unchanged on first run");
  assert(summary.paused.length === 0, "0 paused on first run");

  const rows = await sql(
    `SELECT thread_id, status FROM nexaas_memory.pa_threads
      WHERE workspace = $1 AND user_hall = $2 ORDER BY thread_id`,
    [WORKSPACE, USER],
  );
  assert(rows.length === 2, "2 rows persisted");
  assert(rows.every((r) => r.status === "active"), "all rows active");
}

// ── 2. Idempotent re-run ─────────────────────────────────────────
console.log("\n2. Re-registration is idempotent");
{
  const profile = {
    threads: [
      { id: "hr", display: "👥 HR", domain_aliases: ["hr", "onboarding"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.added.length === 0, "0 added on second run");
  assert(summary.unchanged.length === 2, `2 unchanged (got ${summary.unchanged.length})`);
  assert(summary.updated.length === 0, "0 updated when nothing changed");
}

// ── 3. Adding a new thread ────────────────────────────────────────
console.log("\n3. Adding a new thread");
{
  const profile = {
    threads: [
      { id: "hr", display: "👥 HR", domain_aliases: ["hr", "onboarding"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
      { id: "marketing", display: "📣 Marketing", domain_aliases: ["campaigns"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.added.length === 1 && summary.added[0] === "marketing", "marketing added");
  assert(summary.unchanged.length === 2, "hr + accounting unchanged");
}

// ── 4. Updating an existing thread's display ──────────────────────
console.log("\n4. Updating display refreshes the row");
{
  const profile = {
    threads: [
      { id: "hr", display: "👥 Human Resources", domain_aliases: ["hr", "onboarding"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
      { id: "marketing", display: "📣 Marketing", domain_aliases: ["campaigns"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.updated.length === 1 && summary.updated[0] === "hr", "hr updated");
  assert(summary.unchanged.length === 2, "others unchanged");

  const row = await sql(
    `SELECT display_name FROM nexaas_memory.pa_threads WHERE workspace = $1 AND user_hall = $2 AND thread_id = $3`,
    [WORKSPACE, USER, "hr"],
  );
  assert(row[0]?.display_name === "👥 Human Resources", "display written");
}

// ── 5. Removing a thread pauses, doesn't delete ──────────────────
console.log("\n5. Removed thread is paused, not deleted");
{
  const profile = {
    threads: [
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
      { id: "marketing", display: "📣 Marketing", domain_aliases: ["campaigns"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.paused.length === 1 && summary.paused[0] === "hr", "hr paused");

  const row = await sql(
    `SELECT status FROM nexaas_memory.pa_threads WHERE workspace = $1 AND user_hall = $2 AND thread_id = $3`,
    [WORKSPACE, USER, "hr"],
  );
  assert(row[0]?.status === "paused", "hr row status='paused' (preserved, not deleted)");
}

// ── 6. Re-adding a paused thread reactivates it ──────────────────
console.log("\n6. Re-adding a paused thread reactivates");
{
  const profile = {
    threads: [
      { id: "hr", display: "👥 HR (back)", domain_aliases: ["hr"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: ["billing"] },
      { id: "marketing", display: "📣 Marketing", domain_aliases: ["campaigns"] },
    ],
  };
  const summary = await upsertPaThreads(WORKSPACE, USER, profile);
  assert(summary.updated.length === 1 && summary.updated[0] === "hr", "hr counted as updated");
  const row = await sql(
    `SELECT status, display_name FROM nexaas_memory.pa_threads WHERE workspace = $1 AND user_hall = $2 AND thread_id = $3`,
    [WORKSPACE, USER, "hr"],
  );
  assert(row[0]?.status === "active", "hr back to active");
  assert(row[0]?.display_name === "👥 HR (back)", "new display written");
}

// Cleanup + close pool
await sql(`DELETE FROM nexaas_memory.pa_threads WHERE workspace = $1`, [WORKSPACE]);
await getPool().end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
