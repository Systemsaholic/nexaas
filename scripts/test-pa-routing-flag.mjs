#!/usr/bin/env node
/**
 * Regression test for the PA-routing workspace flag (#126 Wave 5 §9).
 *
 * Exercises resolvePaRoutingVersion() across the matrix of manifest
 * shapes so the dispatcher's gate behaves correctly during canary
 * rollouts (per-user pin to v1) and after a workspace-wide flip to v2.
 *
 * Run:
 *   node --import tsx scripts/test-pa-routing-flag.mjs
 */

import {
  resolvePaRoutingVersion,
  validateManifest,
} from "../packages/runtime/src/schemas/workspace-manifest.ts";

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

function manifest(pa_routing) {
  const raw = { id: "ws", manifest_version: "0.2" };
  if (pa_routing !== undefined) raw.pa_routing = pa_routing;
  const r = validateManifest(raw);
  if (!r.ok) throw new Error(`manifest invalid: ${r.errors.join("; ")}`);
  return r.manifest;
}

console.log("\nDefault behavior (no flag set)");
check("absent manifest → v2 (preserves current behavior)",
  resolvePaRoutingVersion(null, "alice"), "v2");
check("manifest without pa_routing → v2",
  resolvePaRoutingVersion(manifest(), "alice"), "v2");
check("explicit default v2, no users → v2",
  resolvePaRoutingVersion(manifest({ default: "v2" }), "alice"), "v2");

console.log("\nKill-switch (workspace-wide v1)");
check("default v1, no users → v1",
  resolvePaRoutingVersion(manifest({ default: "v1" }), "alice"), "v1");
check("default v1 overrides Zod default (was v2)",
  resolvePaRoutingVersion(manifest({ default: "v1", users: {} }), "anyone"), "v1");

console.log("\nPer-user overrides (canary granularity)");
check("default v2, user pinned v1 → v1 (typical canary holdback)",
  resolvePaRoutingVersion(manifest({ default: "v2", users: { seb: "v1" } }), "seb"), "v1");
check("default v2, different user → v2 (default applies)",
  resolvePaRoutingVersion(manifest({ default: "v2", users: { seb: "v1" } }), "al"), "v2");
check("default v1, user opted in v2 → v2 (early canary)",
  resolvePaRoutingVersion(manifest({ default: "v1", users: { al: "v2" } }), "al"), "v2");
check("default v1, different user → v1 (held back)",
  resolvePaRoutingVersion(manifest({ default: "v1", users: { al: "v2" } }), "mireille"), "v1");

console.log("\nMixed-state staggered rollout (Wave 5 ceremony shape)");
const staggered = manifest({
  default: "v1",
  users: { alice: "v2", bob: "v2", carol: "v1" },
});
check("alice migrated → v2", resolvePaRoutingVersion(staggered, "alice"), "v2");
check("bob migrated → v2", resolvePaRoutingVersion(staggered, "bob"), "v2");
check("carol held back → v1", resolvePaRoutingVersion(staggered, "carol"), "v1");
check("new unknown user falls to default", resolvePaRoutingVersion(staggered, "newjoiner"), "v1");

console.log("\nSchema validation rejects garbage");
const bad1 = validateManifest({ id: "ws", pa_routing: { default: "v3" } });
check("default = v3 rejected", bad1.ok, false);
const bad2 = validateManifest({ id: "ws", pa_routing: { default: "v2", users: { alice: "experimental" } } });
check("user override = experimental rejected", bad2.ok, false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
