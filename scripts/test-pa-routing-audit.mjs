#!/usr/bin/env node
/**
 * Regression test for routing-decisions audit-drawer enhancement (#164).
 *
 * Mocks ExecuteDeps to capture exactly what writeAuditDrawer receives.
 * Verifies the `routing` sub-object appears on every audit-drawer write
 * across the four scenarios that produce one:
 *
 *   1. rewire path → audit drawer has routing.source = "rewire", version = "v2"
 *   2. direct HTTP call → audit drawer has routing.source = "direct"
 *   3. no routing arg supplied → audit drawer has routing = null
 *   4. v1_pinned skip → stub audit drawer with delivery_status = "skipped"
 *
 * Pure: no Postgres required. The mock deps capture calls in memory.
 *
 * Run:
 *   node --import tsx scripts/test-pa-routing-audit.mjs
 */

import {
  executePaNotify,
  writeSkipAuditDrawer,
} from "../packages/runtime/src/api/pa-notify.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

function mockDeps() {
  const captured = { audit: null, pending: null, marker: null };
  return {
    deps: {
      workspace: "test-ws",
      listActiveThreads: async () => [{ thread_id: "inbox", display_name: "Inbox" }],
      findRecentByIdempotency: async () => null,
      writePendingDrawer: async (entry) => {
        captured.pending = entry;
        return { drawer_id: "drw-mock-1" };
      },
      enqueueDeliveryMarker: async (entry) => { captured.marker = entry; },
      writeAuditDrawer: async (entry) => { captured.audit = entry; },
    },
    captured,
  };
}

const baseInput = {
  user: "alice",
  threadId: "inbox",
  urgency: "normal",
  kind: "alert",
  content: "Test message",
  contentFormat: "html",
};

// ── 1. Rewire path → routing stamped on audit drawer ───────────────
console.log("\n1. Dispatcher rewire path stamps routing on audit drawer");
{
  const { deps, captured } = mockDeps();
  const result = await executePaNotify(baseInput, deps, {
    version: "v2",
    source: "rewire",
    decision: "delivered",
    reason: "success",
  });
  assert(result.status === 202, "202 returned on happy path");
  assert(captured.audit != null, "audit drawer was written");
  assert(captured.audit.payload.routing != null, "routing field on audit payload");
  assert(captured.audit.payload.routing.source === "rewire", "routing.source = rewire");
  assert(captured.audit.payload.routing.version === "v2", "routing.version = v2");
  assert(captured.audit.payload.routing.decision === "delivered", "routing.decision = delivered");
  assert(captured.audit.payload.delivery_status === "queued", "delivery_status preserved");
}

// ── 2. Direct HTTP call → source=direct, version omitted ───────────
console.log("\n2. Direct HTTP call stamps source=direct, no version");
{
  const { deps, captured } = mockDeps();
  await executePaNotify(baseInput, deps, {
    source: "direct",
    decision: "delivered",
    reason: "success",
  });
  assert(captured.audit.payload.routing.source === "direct", "routing.source = direct");
  assert(captured.audit.payload.routing.version === undefined, "version omitted for direct");
}

// ── 3. No routing arg → routing = null on the drawer ────────────────
console.log("\n3. Omitted routing arg → routing = null (backwards-compat)");
{
  const { deps, captured } = mockDeps();
  await executePaNotify(baseInput, deps);
  assert(captured.audit.payload.routing === null, "routing = null when omitted");
  assert(captured.audit.payload.delivery_status === "queued", "delivery_status preserved");
}

// ── 4. v1_pinned skip → stub audit drawer ───────────────────────────
console.log("\n4. writeSkipAuditDrawer stamps a skip-shaped drawer");
{
  const { deps, captured } = mockDeps();
  await writeSkipAuditDrawer(deps, {
    user: "alice",
    channelRole: "pa_notify_alice",
    idempotencyKey: "k-skip-1",
    routing: {
      version: "v1",
      source: "rewire",
      decision: "skipped",
      reason: "v1_pinned",
    },
  });
  assert(captured.audit != null, "skip audit drawer written");
  assert(captured.audit.notificationId === "skip", "notificationId sentinel for skip");
  assert(captured.audit.payload.delivery_status === "skipped", "delivery_status = skipped");
  assert(captured.audit.payload.routing.reason === "v1_pinned", "routing.reason = v1_pinned");
  assert(captured.audit.payload.routing.decision === "skipped", "routing.decision = skipped");
  assert(captured.audit.payload.channel_role === "pa_notify_alice", "channel_role preserved");
  assert(captured.audit.payload.idempotency_key === "k-skip-1", "idempotency_key preserved");
}

// ── 5. Audit drawer shape preserves all pre-existing fields ─────────
console.log("\n5. Pre-existing audit-drawer fields are untouched");
{
  const { deps, captured } = mockDeps();
  await executePaNotify({
    ...baseInput,
    originatingSkill: "hr/example",
    waitpointId: "wp-123",
    idempotencyKey: "k-ok",
    metadata: { foo: "bar" },
  }, deps, { source: "direct", decision: "delivered", reason: "success" });
  const p = captured.audit.payload;
  assert(p.user === "alice", "user preserved");
  assert(p.thread_id === "inbox", "thread_id preserved");
  assert(p.urgency === "normal", "urgency preserved");
  assert(p.kind === "alert", "kind preserved");
  assert(p.originating_skill === "hr/example", "originating_skill preserved");
  assert(p.waitpoint_id === "wp-123", "waitpoint_id preserved");
  assert(p.idempotency_key === "k-ok", "idempotency_key preserved");
  assert(p.metadata?.foo === "bar", "metadata preserved");
  assert(typeof p.received_at === "string", "received_at populated");
  assert(typeof p.notification_id === "string" && p.notification_id.startsWith("n-"),
    "notification_id minted");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
