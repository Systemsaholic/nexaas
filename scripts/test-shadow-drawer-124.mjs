#!/usr/bin/env node
/**
 * Regression test for #124 Wave 3 — approval-shadow drawer emit on
 * resolveWaitpoint success.
 *
 * Requires a minimal palace schema (events + wal) and DATABASE_URL.
 *
 * Cases:
 *   1. Resolving an approval-shaped waitpoint emits one shadow drawer
 *      to notifications.delivered.telegram with the expected fields.
 *   2. Resolving a non-approval waitpoint (no channel_role in state) does
 *      NOT emit a shadow drawer.
 *   3. Resolving an inbound-match-shaped waitpoint (channel_role absent)
 *      does NOT emit.
 *   4. Shadow drawer carries `original_notification_id` when the
 *      approval state had one set; null otherwise.
 *   5. resolveWaitpoint still returns runId/skillId/stepId unchanged.
 *   6. The existing resolution drawer (in events/skill/pending-approval)
 *      is written exactly once, not duplicated by the shadow path.
 *
 * Run:
 *   DATABASE_URL=postgresql://nexaas:password@localhost/shadow_drawer_test \
 *     node --import tsx scripts/test-shadow-drawer-124.mjs
 */

import { randomUUID } from "crypto";
import { resolveWaitpoint, palace } from "../packages/palace/src/palace.ts";
import { sql, getPool } from "../packages/palace/src/db.ts";

const WORKSPACE = `test-${Date.now()}`;
let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

async function createApprovalWaitpoint(state) {
  const signal = `approval:${randomUUID()}`;
  const runId = randomUUID();
  const session = palace.enter({ workspace: WORKSPACE, runId, skillId: "test/skill", stepId: "step1" });
  await session.createWaitpoint({
    signal,
    room: { wing: "events", hall: "skill", room: "pending-approval" },
    state,
    timeout: "1h",
  });
  return { signal, runId };
}

async function countShadows() {
  const rows = await sql(
    `SELECT id, content FROM nexaas_memory.events
      WHERE workspace = $1 AND wing = 'notifications' AND hall = 'delivered' AND room = 'telegram'`,
    [WORKSPACE],
  );
  return rows;
}

async function countResolutionDrawers() {
  const rows = await sql(
    `SELECT id FROM nexaas_memory.events
      WHERE workspace = $1 AND wing = 'events' AND hall = 'skill' AND room = 'pending-approval'
        AND dormant_signal IS NULL`,
    [WORKSPACE],
  );
  return rows.length;
}

// ── 1. Approval waitpoint → one shadow drawer ─────────────────────
console.log("\n1. Approval waitpoint emits one shadow drawer");
{
  const { signal } = await createApprovalWaitpoint({
    action_kind: "external_send",
    payload: { to: "alice@example.com" },
    channel_role: "pa_notify_alice",
    notify: { channel_role: "pa_notify_alice" },
    original_notification_id: "n-abc-123",
  });
  const result = await resolveWaitpoint(signal, { decision: "approve" }, "user_alice");
  assert(typeof result.runId === "string", "returns runId");
  assert(typeof result.skillId === "string", "returns skillId");

  const shadows = await countShadows();
  assert(shadows.length === 1, `1 shadow drawer (got ${shadows.length})`);

  const c = JSON.parse(shadows[0].content);
  assert(c.kind === "approval_resolved", "kind=approval_resolved");
  assert(c.waitpoint_signal === signal, "carries signal");
  assert(c.decision === "approve", "carries decision");
  assert(c.resolved_by === "user_alice", "carries resolved_by");
  assert(c.channel_role === "pa_notify_alice", "carries channel_role");
  assert(c.original_notification_id === "n-abc-123", "carries original_notification_id");
  assert(typeof c.resolved_at === "string" && c.resolved_at.includes("T"), "resolved_at ISO");
}

// ── 2. Non-approval waitpoint (no channel_role) → no shadow ───────
console.log("\n2. Waitpoint without channel_role emits no shadow");
{
  const shadowsBefore = (await countShadows()).length;
  const { signal } = await createApprovalWaitpoint({
    action_kind: "raw_timeout",
    payload: { foo: "bar" },
    // no channel_role
  });
  await resolveWaitpoint(signal, { decision: "approve" }, "user_x");
  const shadowsAfter = (await countShadows()).length;
  assert(shadowsAfter === shadowsBefore, `no shadow added (was ${shadowsBefore}, now ${shadowsAfter})`);
}

// ── 3. Inbound-match-shaped waitpoint → no shadow ─────────────────
console.log("\n3. Inbound-match waitpoint emits no shadow");
{
  const shadowsBefore = (await countShadows()).length;
  // Inbound-match has neither action_kind nor channel_role in state
  const { signal } = await createApprovalWaitpoint({
    match_signal: "inbox_match",
    match_room: "inbox.messaging.al",
    content_regex: "^[0-9]{6}$",
  });
  await resolveWaitpoint(signal, { matched: true, code: "123456" }, "telegram-adapter");
  const shadowsAfter = (await countShadows()).length;
  assert(shadowsAfter === shadowsBefore, `no shadow added (was ${shadowsBefore}, now ${shadowsAfter})`);
}

// ── 4. Approval without original_notification_id → null ───────────
console.log("\n4. Approval without original_notification_id → field is null");
{
  const { signal } = await createApprovalWaitpoint({
    action_kind: "external_send",
    payload: { to: "bob@example.com" },
    channel_role: "pa_notify_bob",
  });
  await resolveWaitpoint(signal, { decision: "reject" }, "user_bob");
  const shadows = await sql(
    `SELECT content FROM nexaas_memory.events
      WHERE workspace = $1 AND wing = 'notifications' AND hall = 'delivered' AND room = 'telegram'
      ORDER BY created_at DESC LIMIT 1`,
    [WORKSPACE],
  );
  const c = JSON.parse(shadows[0].content);
  assert(c.original_notification_id === null, "original_notification_id is null when not set");
  assert(c.decision === "reject", "decision propagates");
}

// ── 5. Resolution drawer not duplicated ───────────────────────────
console.log("\n5. Existing resolution path unaffected — no duplicate resolution drawer");
{
  // Each resolveWaitpoint leaves: the original waitpoint drawer (cleared,
  // dormant_signal=NULL) AND one new resolution drawer in the same room.
  // 4 resolves → 4 cleared originals + 4 resolutions = 8 rows.
  // The shadow path writes to a different room (notifications/delivered/telegram),
  // so this count must stay at 8, not 12.
  const count = await countResolutionDrawers();
  assert(count === 8, `8 drawers in pending-approval (4 cleared + 4 resolutions), got ${count} — shadow path didn't pollute`);
}

// ── 6. WAL row for shadow emit ────────────────────────────────────
console.log("\n6. WAL row written for shadow emit");
{
  const walRows = await sql(
    `SELECT payload FROM nexaas_memory.wal
      WHERE workspace = $1 AND op = 'approval_shadow_emit'`,
    [WORKSPACE],
  );
  assert(walRows.length === 2, `2 WAL rows for approval_shadow_emit (one per approval-shaped resolve), got ${walRows.length}`);
}

await getPool().end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
