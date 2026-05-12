#!/usr/bin/env node
/**
 * Regression test for #136 — batch trigger `at_from_field` per-item deadline.
 *
 * Pure unit tests for the field extractor + the per-item-due selector. The
 * full dispatcher flow (claim + enqueue per-item batch) is covered indirectly
 * via the existing test-batch-dispatcher tests; this script focuses on the
 * decision logic so we can assert on edge cases without DB or BullMQ.
 *
 * Run: node --import tsx scripts/test-batch-at-from-field-136.mjs
 */

import {
  extractItemDeadlineMs,
  findPerItemDue,
} from "../packages/runtime/src/tasks/batch-dispatcher.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

const NOW = Date.parse("2026-05-12T10:00:00Z");

// ── 1. extractItemDeadlineMs ──────────────────────────────────────
console.log("\n1. extractItemDeadlineMs()");
{
  // Valid ISO string in the named field
  const past = JSON.stringify({ scheduled_for: "2026-05-12T09:00:00Z", body: "x" });
  assert(extractItemDeadlineMs(past, "scheduled_for") === Date.parse("2026-05-12T09:00:00Z"), "past ISO parsed");

  const future = JSON.stringify({ scheduled_for: "2026-05-12T11:00:00Z" });
  assert(extractItemDeadlineMs(future, "scheduled_for") === Date.parse("2026-05-12T11:00:00Z"), "future ISO parsed");

  // Missing field
  assert(extractItemDeadlineMs(JSON.stringify({ other: "x" }), "scheduled_for") === null, "missing field → null");

  // Non-string field
  assert(extractItemDeadlineMs(JSON.stringify({ scheduled_for: 1715515200 }), "scheduled_for") === null, "number value → null (we require ISO string)");
  assert(extractItemDeadlineMs(JSON.stringify({ scheduled_for: null }), "scheduled_for") === null, "null value → null");
  assert(extractItemDeadlineMs(JSON.stringify({ scheduled_for: ["a"] }), "scheduled_for") === null, "array value → null");

  // Unparseable string
  assert(extractItemDeadlineMs(JSON.stringify({ scheduled_for: "not-a-date" }), "scheduled_for") === null, "unparseable string → null");
  assert(extractItemDeadlineMs(JSON.stringify({ scheduled_for: "" }), "scheduled_for") === null, "empty string → null");

  // Malformed JSON
  assert(extractItemDeadlineMs("{not json", "scheduled_for") === null, "malformed JSON → null");

  // Non-object root
  assert(extractItemDeadlineMs(JSON.stringify("plain string"), "scheduled_for") === null, "non-object root → null");
  assert(extractItemDeadlineMs(JSON.stringify(null), "scheduled_for") === null, "null root → null");
}

// ── 2. findPerItemDue — no at_from_field condition ────────────────
console.log("\n2. findPerItemDue() with no at_from_field returns []");
{
  const items = [
    { id: "a", content: JSON.stringify({ scheduled_for: "2026-05-12T09:00:00Z" }), created_at: "2026-05-12T00:00:00Z" },
  ];
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [{ kind: "count_at_least", n: 10 }],
    onEmpty: "skip", ordering: "arrival",
  };
  const due = findPerItemDue(items, sub, NOW);
  assert(due.length === 0, "no at_from_field condition → no per-item due");
}

// ── 3. findPerItemDue — mixed past + future items ─────────────────
console.log("\n3. findPerItemDue() returns only past items");
{
  const items = [
    { id: "past1", content: JSON.stringify({ scheduled_for: "2026-05-12T09:00:00Z" }), created_at: "2026-05-12T00:00:00Z" },
    { id: "past2", content: JSON.stringify({ scheduled_for: "2026-05-12T09:30:00Z" }), created_at: "2026-05-12T00:00:00Z" },
    { id: "future", content: JSON.stringify({ scheduled_for: "2026-05-12T11:00:00Z" }), created_at: "2026-05-12T00:00:00Z" },
    { id: "missing", content: JSON.stringify({ body: "no deadline" }), created_at: "2026-05-12T00:00:00Z" },
  ];
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [{ kind: "at_from_field", field: "scheduled_for" }],
    onEmpty: "skip", ordering: "arrival",
  };
  const due = findPerItemDue(items, sub, NOW);
  assert(due.length === 2, `2 due items (got ${due.length})`);
  const dueIds = due.map((d) => d.item.id).sort();
  assert(dueIds[0] === "past1" && dueIds[1] === "past2", "past1 + past2 due, future + missing skipped");
  assert(due.every((d) => d.field === "scheduled_for"), "field captured");
}

// ── 4. Item exactly at deadline → fires (boundary inclusive) ──────
console.log("\n4. Item with deadline == now fires (inclusive boundary)");
{
  const items = [
    { id: "exact", content: JSON.stringify({ scheduled_for: new Date(NOW).toISOString() }), created_at: "x" },
  ];
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [{ kind: "at_from_field", field: "scheduled_for" }],
    onEmpty: "skip", ordering: "arrival",
  };
  assert(findPerItemDue(items, sub, NOW).length === 1, "deadline == now fires");
}

// ── 5. Custom field name ──────────────────────────────────────────
console.log("\n5. Custom field name parses");
{
  const items = [
    { id: "a", content: JSON.stringify({ fire_at: "2026-05-12T09:00:00Z" }), created_at: "x" },
  ];
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [{ kind: "at_from_field", field: "fire_at" }],
    onEmpty: "skip", ordering: "arrival",
  };
  assert(findPerItemDue(items, sub, NOW).length === 1, "custom field works");
}

// ── 6. Multiple at_from_field conditions → first match wins ──────
console.log("\n6. Multiple at_from_field conditions don't double-fire one item");
{
  const items = [
    { id: "a", content: JSON.stringify({ scheduled_for: "2026-05-12T09:00:00Z", fire_at: "2026-05-12T09:00:00Z" }), created_at: "x" },
  ];
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [
      { kind: "at_from_field", field: "scheduled_for" },
      { kind: "at_from_field", field: "fire_at" },
    ],
    onEmpty: "skip", ordering: "arrival",
  };
  const due = findPerItemDue(items, sub, NOW);
  assert(due.length === 1, `1 entry for the item (got ${due.length}) — no duplicate firing`);
}

// ── 7. Empty items list ───────────────────────────────────────────
console.log("\n7. Empty pending list → no per-item due");
{
  const sub = {
    skillId: "x", manifestPath: "/x", execType: "ai-exec",
    conditions: [{ kind: "at_from_field", field: "scheduled_for" }],
    onEmpty: "skip", ordering: "arrival",
  };
  assert(findPerItemDue([], sub, NOW).length === 0, "empty list handled");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
