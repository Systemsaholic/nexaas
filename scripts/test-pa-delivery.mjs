#!/usr/bin/env node
/**
 * Regression test for pa-delivery helpers — claim/ack primitives backed
 * by the pa_delivery_marker sidecar.
 *
 * Verifies the four core properties:
 *   1. enqueueDelivery is idempotent (re-insert is a no-op)
 *   2. claimNextDelivery serializes per-thread (concurrent claimers
 *      against the same thread don't both win)
 *   3. claimNextDelivery parallels across threads
 *   4. markDeliveryFailed transitions to 'dead' + emits ops_alert
 *      once retries hit the threshold
 *
 * Run:
 *   DATABASE_URL=postgresql://nexaas_test:test@127.0.0.1/pa_delivery_test \
 *     NEXAAS_PA_MAX_RETRIES=2 \
 *     node --import tsx scripts/test-pa-delivery.mjs
 */

import {
  enqueueDelivery,
  claimNextDelivery,
  markDeliverySent,
  markDeliveryFailed,
  reapStaleDeliveryClaims,
} from "../packages/runtime/src/pa/delivery.ts";
import { sql, getPool } from "../packages/palace/src/db.ts";
import { randomUUID } from "crypto";

const WORKSPACE = `test-${Date.now()}`;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

async function insertDrawer(workspace, user, thread) {
  const id = randomUUID();
  const payload = JSON.stringify({ user, thread_id: thread, content: "hi" });
  await sql(
    `INSERT INTO nexaas_memory.events
       (id, workspace, wing, hall, room, content, event_type, agent_id, normalize_version)
     VALUES ($1, $2, 'notifications', 'pending', $3, $4, 'drawer', 'test', 1)`,
    [id, workspace, `pa-routed.${thread}`, payload],
  );
  return id;
}

async function statusOf(workspace, drawerId) {
  const rows = await sql(
    `SELECT status, retries, last_error FROM nexaas_memory.pa_delivery_marker
       WHERE workspace = $1 AND drawer_id = $2`,
    [workspace, drawerId],
  );
  return rows[0] ?? null;
}

async function opsAlertCount(workspace) {
  const rows = await sql(
    `SELECT COUNT(*)::text AS n FROM nexaas_memory.ops_alerts
       WHERE workspace = $1 AND event_type = 'pa_delivery_dead'`,
    [workspace],
  );
  return Number(rows[0]?.n ?? "0");
}

// ── 1. enqueueDelivery idempotency ───────────────────────────────────
console.log("\n1. enqueueDelivery is idempotent");
{
  const drawer = await insertDrawer(WORKSPACE, "alice", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "alice", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "alice", "inbox");
  const rows = await sql(
    `SELECT COUNT(*)::text AS n FROM nexaas_memory.pa_delivery_marker
       WHERE workspace = $1 AND drawer_id = $2`,
    [WORKSPACE, drawer],
  );
  assert(Number(rows[0].n) === 1, "re-enqueue with same drawer_id is no-op (one row total)");
  const s = await statusOf(WORKSPACE, drawer);
  assert(s.status === "queued", `status starts as 'queued' (got ${s.status})`);
}

// ── 2. Per-thread serialization via SKIP LOCKED ──────────────────────
console.log("\n2. Concurrent claims for the SAME thread serialize");
{
  const d1 = await insertDrawer(WORKSPACE, "bob", "inbox");
  const d2 = await insertDrawer(WORKSPACE, "bob", "inbox");
  await enqueueDelivery(WORKSPACE, d1, "bob", "inbox");
  await enqueueDelivery(WORKSPACE, d2, "bob", "inbox");

  const [a, b] = await Promise.all([
    claimNextDelivery(WORKSPACE, "bob", "inbox"),
    claimNextDelivery(WORKSPACE, "bob", "inbox"),
  ]);
  // Both should succeed (SKIP LOCKED means each claims a different row, FIFO).
  assert(a && b, "both concurrent claims got a row");
  assert(a.drawer_id !== b.drawer_id, "different rows returned (no duplicate claim)");

  // A third concurrent claim returns null.
  const third = await claimNextDelivery(WORKSPACE, "bob", "inbox");
  assert(third === null, "third claim returns null when no more queued");
}

// ── 3. Cross-thread parallelism — different threads, independent ─────
console.log("\n3. Different threads claim independently");
{
  const d1 = await insertDrawer(WORKSPACE, "carol", "inbox");
  const d2 = await insertDrawer(WORKSPACE, "carol", "hr");
  await enqueueDelivery(WORKSPACE, d1, "carol", "inbox");
  await enqueueDelivery(WORKSPACE, d2, "carol", "hr");

  const [inbox, hr] = await Promise.all([
    claimNextDelivery(WORKSPACE, "carol", "inbox"),
    claimNextDelivery(WORKSPACE, "carol", "hr"),
  ]);
  assert(inbox?.thread_id === "inbox", "inbox thread claimed");
  assert(hr?.thread_id === "hr", "hr thread claimed");
}

// ── 4. markDeliverySent transitions to 'sent' ────────────────────────
console.log("\n4. markDeliverySent records channel_message_id and sent_at");
{
  const drawer = await insertDrawer(WORKSPACE, "dave", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "dave", "inbox");
  const claim = await claimNextDelivery(WORKSPACE, "dave", "inbox");
  await markDeliverySent(claim, "telegram-msg-12345");
  const s = await statusOf(WORKSPACE, drawer);
  assert(s.status === "sent", `status=sent (got ${s.status})`);
  const row = await sql(
    `SELECT channel_message_id, sent_at FROM nexaas_memory.pa_delivery_marker
       WHERE workspace = $1 AND drawer_id = $2`,
    [WORKSPACE, drawer],
  );
  assert(row[0].channel_message_id === "telegram-msg-12345", "channel_message_id recorded");
  assert(row[0].sent_at != null, "sent_at populated");
}

// ── 5. markDeliveryFailed below threshold → 'failed' + retry path ────
console.log("\n5. markDeliveryFailed cycles back to 'failed' below retry threshold");
{
  // NEXAAS_PA_MAX_RETRIES=2 means the first failure is retries=1
  // (status='failed', re-claimable); second failure is retries=2
  // (terminal 'dead').
  const drawer = await insertDrawer(WORKSPACE, "eve", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "eve", "inbox");

  // First attempt fails.
  const c1 = await claimNextDelivery(WORKSPACE, "eve", "inbox");
  await markDeliveryFailed(c1, "telegram 429 throttled");
  const s1 = await statusOf(WORKSPACE, drawer);
  assert(s1.status === "failed", `after 1st failure status='failed' (got ${s1.status})`);
  assert(s1.retries === 1, `retries=1 (got ${s1.retries})`);

  // Re-claim should succeed (row eligible: status='failed', retries < MAX=2).
  const c2 = await claimNextDelivery(WORKSPACE, "eve", "inbox");
  assert(c2 !== null && c2.drawer_id === drawer, "stale 'failed' row is re-claimable");
  assert(c2.retries === 1, `re-claim shows retries=1 (got ${c2?.retries})`);

  // Second failure pushes retries to MAX → 'dead'.
  await markDeliveryFailed(c2, "telegram timeout");
  const s2 = await statusOf(WORKSPACE, drawer);
  assert(s2.status === "dead", `after 2nd failure status='dead' (got ${s2.status})`);
  assert(s2.retries === 2, `retries=2 (got ${s2.retries})`);
  assert(s2.last_error.startsWith("telegram timeout"), "last_error preserved");
}

// ── 6. Terminal 'dead' emits an ops_alert ────────────────────────────
console.log("\n6. Dead delivery emits an ops_alert row");
{
  const before = await opsAlertCount(WORKSPACE);
  assert(before >= 1, `ops_alert row written when 'eve' went terminal (got ${before})`);
}

// ── 7. Reaper resets stale 'claimed' rows ────────────────────────────
console.log("\n7. Reaper resets stale 'claimed' rows back to 'failed'");
{
  const drawer = await insertDrawer(WORKSPACE, "frank", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "frank", "inbox");
  const claim = await claimNextDelivery(WORKSPACE, "frank", "inbox");
  assert(claim !== null, "claim succeeded");

  // Backdate claimed_at to simulate a crashed consumer.
  await sql(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET claimed_at = now() - interval '5 minutes'
      WHERE workspace = $1 AND drawer_id = $2`,
    [WORKSPACE, drawer],
  );

  const reaped = await reapStaleDeliveryClaims(WORKSPACE);
  assert(reaped >= 1, `reaper reset ≥1 row (got ${reaped})`);
  const s = await statusOf(WORKSPACE, drawer);
  assert(s.status === "failed", `status='failed' after reap (got ${s.status})`);
  assert(s.last_error?.includes("reaped"), "last_error notes reaping");

  // Re-claim works.
  const reclaimed = await claimNextDelivery(WORKSPACE, "frank", "inbox");
  assert(reclaimed?.drawer_id === drawer, "reaped row becomes re-claimable");
}

// ── 8. Past-max-retries rows are not claimable ───────────────────────
console.log("\n8. Rows at MAX_RETRIES are not re-claimable");
{
  const drawer = await insertDrawer(WORKSPACE, "grace", "inbox");
  await enqueueDelivery(WORKSPACE, drawer, "grace", "inbox");
  await sql(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET retries = 2, status = 'failed'
      WHERE workspace = $1 AND drawer_id = $2`,
    [WORKSPACE, drawer],
  );
  const claim = await claimNextDelivery(WORKSPACE, "grace", "inbox");
  assert(claim === null, "row at MAX retries not eligible for claim");
}

// Cleanup
await sql(`DELETE FROM nexaas_memory.events WHERE workspace = $1`, [WORKSPACE]);
await sql(`DELETE FROM nexaas_memory.pa_delivery_marker WHERE workspace = $1`, [WORKSPACE]);
await sql(`DELETE FROM nexaas_memory.ops_alerts WHERE workspace = $1`, [WORKSPACE]);
await getPool().end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
