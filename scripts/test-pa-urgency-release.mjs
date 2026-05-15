#!/usr/bin/env node
/**
 * Regression test for urgency-tier release gating (#123 Wave 2.4).
 *
 * Verifies that enqueueDelivery picks the right release_at per urgency
 * tier and that claimNextDelivery refuses to surface held rows.
 *
 * Pure helpers are tested with computeReleaseAt; the integration
 * (immediate is claimable now / normal is held / past-release becomes
 * claimable) runs against a real Postgres.
 *
 * Run:
 *   DATABASE_URL=postgresql://nexaas_test:test@127.0.0.1/pa_delivery_test \
 *     NEXAAS_PA_NORMAL_HOLD_MINUTES=15 \
 *     NEXAAS_PA_LOW_RELEASE_HOUR=7 \
 *     NEXAAS_PA_LOW_RELEASE_MINUTE=30 \
 *     node --import tsx scripts/test-pa-urgency-release.mjs
 */

import {
  enqueueDelivery,
  claimNextDelivery,
  computeReleaseAt,
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
  await sql(
    `INSERT INTO nexaas_memory.events
       (id, workspace, wing, hall, room, content, event_type, agent_id, normalize_version)
     VALUES ($1, $2, 'notifications', 'pending', $3, '{}', 'drawer', 'test', 1)`,
    [id, workspace, `pa-routed.${thread}`, ],
  );
  return id;
}

async function releaseAtOf(workspace, drawerId) {
  const rows = await sql(
    `SELECT release_at FROM nexaas_memory.pa_delivery_marker
       WHERE workspace = $1 AND drawer_id = $2`,
    [workspace, drawerId],
  );
  return rows[0]?.release_at ?? null;
}

// ── 1. computeReleaseAt — pure helper ──────────────────────────────
console.log("\n1. computeReleaseAt picks the right wall clock per tier");
{
  const now = new Date("2026-05-15T10:00:00Z");
  const immediate = computeReleaseAt("immediate", now);
  assert(immediate.getTime() === now.getTime(), "immediate releases now");

  const normal = computeReleaseAt("normal", now);
  const expectedNormal = new Date("2026-05-15T10:15:00Z");
  assert(normal.getTime() === expectedNormal.getTime(),
    `normal releases now + 15min (got ${normal.toISOString()})`);

  // For low: depends on local-time hour/minute, so just check that
  // it's in the future and at the configured minute.
  const low = computeReleaseAt("low", now);
  assert(low.getTime() > now.getTime(), "low releases in the future");
  assert(low.getMinutes() === 30, `low at minute 30 (got ${low.getMinutes()})`);
  assert(low.getHours() === 7, `low at hour 7 (got ${low.getHours()})`);

  // If we're already past today's release time, schedule for tomorrow.
  const past = new Date();
  past.setHours(8, 0, 0, 0);
  const lowFromPast = computeReleaseAt("low", past);
  assert(lowFromPast.getTime() > past.getTime(),
    "past today's release → scheduled for tomorrow");
  assert(lowFromPast.getDate() !== past.getDate() || lowFromPast.getMonth() !== past.getMonth(),
    "next day's date (different day from input)");
}

// ── 2. enqueueDelivery sets release_at per tier ────────────────────
console.log("\n2. enqueueDelivery stores the right release_at");
{
  const dImm = await insertDrawer(WORKSPACE, "alice", "inbox");
  await enqueueDelivery(WORKSPACE, dImm, "alice", "inbox", "immediate");
  const rImm = await releaseAtOf(WORKSPACE, dImm);
  assert(rImm.getTime() <= Date.now(), "immediate release_at ≤ now");

  const dNorm = await insertDrawer(WORKSPACE, "alice", "inbox");
  await enqueueDelivery(WORKSPACE, dNorm, "alice", "inbox", "normal");
  const rNorm = await releaseAtOf(WORKSPACE, dNorm);
  const heldFor = rNorm.getTime() - Date.now();
  // Allow ±2s margin for clock + insert latency.
  assert(heldFor > 14 * 60_000 && heldFor < 16 * 60_000,
    `normal held ~15min (got ${Math.round(heldFor / 1000)}s)`);

  const dLow = await insertDrawer(WORKSPACE, "alice", "inbox");
  await enqueueDelivery(WORKSPACE, dLow, "alice", "inbox", "low");
  const rLow = await releaseAtOf(WORKSPACE, dLow);
  assert(rLow.getTime() > Date.now(),
    "low release_at is in the future");
}

// ── 3. claimNextDelivery refuses to surface held rows ──────────────
console.log("\n3. Held rows are invisible to claimNextDelivery");
{
  // Clean slate for bob.
  await sql(`DELETE FROM nexaas_memory.pa_delivery_marker WHERE workspace = $1 AND user_hall = 'bob'`, [WORKSPACE]);

  const dNorm = await insertDrawer(WORKSPACE, "bob", "inbox");
  await enqueueDelivery(WORKSPACE, dNorm, "bob", "inbox", "normal");
  const claim1 = await claimNextDelivery(WORKSPACE, "bob", "inbox");
  assert(claim1 === null, "normal-held row not claimable yet");

  const dImm = await insertDrawer(WORKSPACE, "bob", "inbox");
  await enqueueDelivery(WORKSPACE, dImm, "bob", "inbox", "immediate");
  const claim2 = await claimNextDelivery(WORKSPACE, "bob", "inbox");
  assert(claim2 !== null, "immediate row IS claimable");
  assert(claim2.drawer_id === dImm, "claimed the immediate row, not the held normal");

  // Second claim should return null — only one row was eligible.
  const claim3 = await claimNextDelivery(WORKSPACE, "bob", "inbox");
  assert(claim3 === null, "no more claimable rows (normal still held)");
}

// ── 4. Past-release row becomes claimable ──────────────────────────
console.log("\n4. Row becomes claimable once release_at passes");
{
  await sql(`DELETE FROM nexaas_memory.pa_delivery_marker WHERE workspace = $1 AND user_hall = 'carol'`, [WORKSPACE]);

  const dNorm = await insertDrawer(WORKSPACE, "carol", "inbox");
  await enqueueDelivery(WORKSPACE, dNorm, "carol", "inbox", "normal");

  const claimHeld = await claimNextDelivery(WORKSPACE, "carol", "inbox");
  assert(claimHeld === null, "fresh normal is held");

  // Backdate release_at to simulate time passing.
  await sql(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET release_at = now() - interval '1 minute'
      WHERE workspace = $1 AND drawer_id = $2`,
    [WORKSPACE, dNorm],
  );
  const claimReleased = await claimNextDelivery(WORKSPACE, "carol", "inbox");
  assert(claimReleased?.drawer_id === dNorm, "row is claimable after release_at passes");
}

// ── 5. Default urgency parameter preserves backwards-compat ────────
console.log("\n5. Default urgency = 'normal' keeps existing callers safe");
{
  await sql(`DELETE FROM nexaas_memory.pa_delivery_marker WHERE workspace = $1 AND user_hall = 'dave'`, [WORKSPACE]);

  const drawer = await insertDrawer(WORKSPACE, "dave", "inbox");
  // Old call shape (no urgency arg) → defaults to 'normal' → held.
  await enqueueDelivery(WORKSPACE, drawer, "dave", "inbox");
  const claim = await claimNextDelivery(WORKSPACE, "dave", "inbox");
  assert(claim === null, "default-urgency caller gets normal-tier hold");
}

// Cleanup
await sql(`DELETE FROM nexaas_memory.events WHERE workspace = $1`, [WORKSPACE]);
await sql(`DELETE FROM nexaas_memory.pa_delivery_marker WHERE workspace = $1`, [WORKSPACE]);
await getPool().end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
