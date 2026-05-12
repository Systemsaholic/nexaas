#!/usr/bin/env node
/**
 * Regression test for #135 — concurrency-group template interpolation.
 *
 * The new `resolveConcurrencyGroups` helper substitutes `{field}` placeholders
 * in a skill's `concurrency_groups` declaration with values from the trigger
 * payload at dispatch time. Lets a skill declare per-payload isolation
 * (e.g. `pa-notify:{user}:{thread_id}`) without writing a custom dispatcher.
 *
 * Run: node --import tsx scripts/test-concurrency-group-templates-135.mjs
 */

import { resolveConcurrencyGroups } from "../packages/runtime/src/concurrency-groups.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. Pass-through (no placeholders) ─────────────────────────────
console.log("\n1. Groups without placeholders pass through unchanged");
{
  const r = resolveConcurrencyGroups(["sqlite:onboarding.db", "vendor-rate-limit"], { entity_id: "x" });
  assert(r.length === 2, "both groups kept");
  assert(r[0] === "sqlite:onboarding.db", "first group unchanged");
  assert(r[1] === "vendor-rate-limit", "second group unchanged");
}

// ── 2. Single placeholder ─────────────────────────────────────────
console.log("\n2. Single placeholder substitution");
{
  const r = resolveConcurrencyGroups(["entity:{entity_id}"], { entity_id: "abc" });
  assert(r.length === 1 && r[0] === "entity:abc", "{entity_id} → abc");
}

// ── 3. Multiple placeholders in one group ─────────────────────────
console.log("\n3. Multiple placeholders in one group");
{
  const r = resolveConcurrencyGroups(["pa-notify:{user}:{thread_id}"], { user: "alice", thread_id: "hr" });
  assert(r.length === 1 && r[0] === "pa-notify:alice:hr", "both substitutions applied");
}

// ── 4. Coerce number / boolean primitives ─────────────────────────
console.log("\n4. Numeric + boolean coercion");
{
  const r = resolveConcurrencyGroups(["job:{n}:{flag}"], { n: 42, flag: true });
  assert(r[0] === "job:42:true", `numbers + booleans coerced to string (got '${r[0]}')`);
}

// ── 5. Missing field drops the group ──────────────────────────────
console.log("\n5. Missing placeholder field drops the group");
{
  const r = resolveConcurrencyGroups(["entity:{entity_id}", "sqlite:onboarding.db"], { other: "x" });
  assert(r.length === 1, "1 group survives (dropped one with unresolved placeholder)");
  assert(r[0] === "sqlite:onboarding.db", "literal group kept");
}

// ── 6. Null / undefined / non-primitive value drops ───────────────
console.log("\n6. null/object/array value drops the group");
{
  assert(resolveConcurrencyGroups(["e:{x}"], { x: null }).length === 0, "null drops");
  assert(resolveConcurrencyGroups(["e:{x}"], { x: undefined }).length === 0, "undefined drops");
  assert(resolveConcurrencyGroups(["e:{x}"], { x: { nested: 1 } }).length === 0, "object drops");
  assert(resolveConcurrencyGroups(["e:{x}"], { x: [1, 2] }).length === 0, "array drops");
}

// ── 7. Mixed: pass-through + substitute + drop ────────────────────
console.log("\n7. Mixed: literals + substitutes + drops");
{
  const r = resolveConcurrencyGroups(
    ["sqlite:onboarding.db", "entity:{entity_id}", "user:{missing_field}"],
    { entity_id: "abc" },
  );
  assert(r.length === 2, "2 groups survive");
  assert(r.includes("sqlite:onboarding.db"), "literal kept");
  assert(r.includes("entity:abc"), "substituted kept");
  assert(!r.some((g) => g.includes("missing_field") || g === "user:"), "missing dropped (no malformed group)");
}

// ── 8. Empty / undefined inputs ───────────────────────────────────
console.log("\n8. Empty / undefined inputs");
{
  assert(resolveConcurrencyGroups(undefined, { x: "y" }).length === 0, "undefined groups → []");
  assert(resolveConcurrencyGroups([], { x: "y" }).length === 0, "empty groups → []");
  assert(resolveConcurrencyGroups(["literal"], undefined).length === 1, "undefined payload + literal group → kept");
  assert(resolveConcurrencyGroups(["{x}"], undefined).length === 0, "undefined payload + placeholder → dropped");
}

// ── 9. Same placeholder appears twice ─────────────────────────────
console.log("\n9. Same placeholder appears twice in one group");
{
  const r = resolveConcurrencyGroups(["{user}:{user}"], { user: "alice" });
  assert(r[0] === "alice:alice", "all occurrences substituted");
}

// ── 10. Placeholder regex doesn't match weird patterns ────────────
console.log("\n10. Placeholder grammar — only valid identifiers");
{
  // Empty braces don't match (regex requires at least one identifier char)
  const r = resolveConcurrencyGroups(["a:{}"], { "": "x" });
  assert(r[0] === "a:{}", "empty braces left literal (no substitution)");
  // Numeric-first identifier doesn't match
  const r2 = resolveConcurrencyGroups(["a:{1x}"], { "1x": "y" });
  assert(r2[0] === "a:{1x}", "identifier starting with digit left literal");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
