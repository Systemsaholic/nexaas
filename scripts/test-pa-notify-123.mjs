#!/usr/bin/env node
/**
 * Regression test for #123 Wave 2 — POST /api/pa/<user>/notify endpoint
 * primitives (input validation + executePaNotify orchestration).
 *
 * Two halves:
 *
 *   Half A (pure)  — exhaustive validatePaNotifyInput cases. No DB.
 *   Half B (deps stubbed) — executePaNotify with deps replaced by an
 *                          in-memory mock that records the calls. No DB.
 *
 * Run: node --import tsx scripts/test-pa-notify-123.mjs
 */

import {
  validatePaNotifyInput,
  executePaNotify,
} from "../packages/runtime/src/api/pa-notify.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── Half A: validatePaNotifyInput ─────────────────────────────────
console.log("\n=== validation cases ===\n");

console.log("1. happy path");
{
  const ok = validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "alert",
    content: "test", content_format: "html",
  });
  assert(!("error" in ok), "minimal valid input passes");
  assert(!("error" in ok) && ok.user === "alice", "user from path");
  assert(!("error" in ok) && ok.threadId === "hr", "thread_id parsed");
}

console.log("\n2. user path param validation");
{
  assert("error" in validatePaNotifyInput("Alice", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x" }), "uppercase user rejected");
  assert("error" in validatePaNotifyInput("", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x" }), "empty user rejected");
  assert("error" in validatePaNotifyInput("-alice", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x" }), "leading hyphen rejected");
  assert(!("error" in validatePaNotifyInput("alice-1", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x" })), "hyphenated user allowed");
}

console.log("\n3. body shape");
{
  assert("error" in validatePaNotifyInput("alice", null), "null body rejected");
  assert("error" in validatePaNotifyInput("alice", "string"), "string body rejected");
  assert("error" in validatePaNotifyInput("alice", []), "array body rejected");
}

console.log("\n4. thread_id validation");
{
  assert("error" in validatePaNotifyInput("alice", { thread_id: "HR", urgency: "normal", kind: "alert", content: "x" }), "uppercase thread_id rejected");
  assert("error" in validatePaNotifyInput("alice", { thread_id: "1hr", urgency: "normal", kind: "alert", content: "x" }), "thread_id starting with digit rejected");
  assert("error" in validatePaNotifyInput("alice", { urgency: "normal", kind: "alert", content: "x" }), "missing thread_id rejected");
}

console.log("\n5. urgency + kind enum");
{
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "URGENT", kind: "alert", content: "x" }), "bad urgency rejected");
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "normal", kind: "ping", content: "x" }), "bad kind rejected");
  for (const u of ["immediate", "normal", "low"]) {
    assert(!("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: u, kind: "alert", content: "x" })), `urgency=${u} accepted`);
  }
}

console.log("\n6. content + content_format");
{
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "normal", kind: "alert" }), "missing content rejected");
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "normal", kind: "alert", content: "" }), "empty content rejected");
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x".repeat(8193) }), "oversize content rejected");
  assert("error" in validatePaNotifyInput("alice", { thread_id: "hr", urgency: "normal", kind: "alert", content: "x", content_format: "ascii" }), "bad content_format rejected");
}

console.log("\n7. kind=approval extra requirements");
{
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
  }), "approval without waitpoint_id rejected");
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
    waitpoint_id: "wp-1",
  }), "approval without actions rejected");
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
    waitpoint_id: "wp-1", actions: [],
  }), "approval with empty actions rejected");
  const ok = validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
    waitpoint_id: "wp-1",
    actions: [{ button_id: "b1", label: "Approve" }],
  });
  assert(!("error" in ok), "approval with waitpoint_id + ≥1 action accepted");
}

console.log("\n8. actions shape");
{
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
    waitpoint_id: "wp-1", actions: [{ button_id: "b1" }],
  }), "action missing label rejected");
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "approval", content: "x",
    waitpoint_id: "wp-1", actions: [{ button_id: "b1", label: "x".repeat(81) }],
  }), "oversize action label rejected");
}

console.log("\n9. idempotency_key + metadata");
{
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "alert", content: "x",
    idempotency_key: "x".repeat(201),
  }), "oversize idempotency_key rejected");
  assert("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "alert", content: "x",
    metadata: "string",
  }), "non-object metadata rejected");
  assert(!("error" in validatePaNotifyInput("alice", {
    thread_id: "hr", urgency: "normal", kind: "alert", content: "x",
    idempotency_key: "k1", metadata: { foo: "bar" },
  })), "valid idempotency + metadata accepted");
}

// ── Half B: executePaNotify with stubbed deps ─────────────────────
console.log("\n=== orchestration cases ===\n");

function makeDeps(threads = [{ thread_id: "hr", display_name: "HR" }], priorByKey = {}) {
  const writes = { pending: [], audit: [] };
  return {
    deps: {
      workspace: "w-test",
      listActiveThreads: async () => threads,
      findRecentByIdempotency: async (_w, _u, k) => priorByKey[k] ?? null,
      writePendingDrawer: async (e) => writes.pending.push(e),
      writeAuditDrawer: async (e) => writes.audit.push(e),
    },
    writes,
  };
}

console.log("10. unknown thread → 404 with available_threads");
{
  const { deps } = makeDeps([{ thread_id: "hr", display_name: "HR" }, { thread_id: "accounting", display_name: "Accounting" }]);
  const out = await executePaNotify({
    user: "alice", threadId: "marketing", urgency: "normal", kind: "alert", content: "hi",
  }, deps);
  assert("error" in out && out.status === 404, "404 returned");
  assert("error" in out && out.error === "thread_not_found", "thread_not_found error code");
  assert("error" in out && Array.isArray(out.details?.available_threads), "available_threads list included");
  assert("error" in out && out.details?.available_threads?.length === 2, "lists both active threads");
}

console.log("\n11. happy path — 202 with notification_id");
{
  const { deps, writes } = makeDeps();
  const out = await executePaNotify({
    user: "alice", threadId: "hr", urgency: "normal", kind: "alert", content: "ok",
  }, deps);
  assert(!("error" in out) && out.status === 202, "202 returned");
  assert(!("error" in out) && out.body.data.notification_id.startsWith("n-"), "notification_id has n- prefix");
  assert(writes.pending.length === 1, "pending drawer written");
  assert(writes.audit.length === 1, "audit drawer written");
  assert(!("error" in out) && out.body.data.idempotency_hit === false, "idempotency_hit=false on first run");
}

console.log("\n12. idempotency hit short-circuits");
{
  const priorId = "n-existing-12345";
  const { deps, writes } = makeDeps([{ thread_id: "hr", display_name: "HR" }], { "key-x": priorId });
  const out = await executePaNotify({
    user: "alice", threadId: "hr", urgency: "normal", kind: "alert", content: "x",
    idempotencyKey: "key-x",
  }, deps);
  assert(!("error" in out) && out.body.data.notification_id === priorId, "returns prior notification_id");
  assert(!("error" in out) && out.body.data.idempotency_hit === true, "idempotency_hit=true");
  assert(writes.pending.length === 0, "no new pending drawer");
  assert(writes.audit.length === 0, "no new audit drawer");
}

console.log("\n13. pending drawer payload + audit drawer payload");
{
  const { deps, writes } = makeDeps();
  await executePaNotify({
    user: "alice", threadId: "hr", urgency: "immediate", kind: "approval",
    content: "Approve?", contentFormat: "html",
    originatingSkill: "hr/skill", waitpointId: "wp-99",
    actions: [{ button_id: "approve", label: "Approve" }],
    metadata: { advisor: "abc" },
  }, deps);
  const pending = writes.pending[0];
  assert(pending.threadId === "hr", "pending drawer threadId");
  assert(pending.payload.kind === "approval", "pending drawer kind");
  assert(pending.payload.waitpoint_id === "wp-99", "pending drawer waitpoint_id");
  assert(pending.payload.actions?.length === 1, "pending drawer actions");
  assert(pending.payload.metadata?.advisor === "abc", "pending drawer metadata");
  const audit = writes.audit[0];
  assert(audit.payload.delivery_status === "queued", "audit drawer delivery_status");
  assert(audit.payload.notification_id === pending.notificationId, "audit + pending share notification_id");
}

console.log("\n14. audit failure doesn't fail the request");
{
  const { deps } = makeDeps();
  deps.writeAuditDrawer = async () => { throw new Error("simulated audit failure"); };
  const out = await executePaNotify({
    user: "alice", threadId: "hr", urgency: "normal", kind: "alert", content: "x",
  }, deps);
  assert(!("error" in out) && out.status === 202, "still returns 202 when audit throws");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
