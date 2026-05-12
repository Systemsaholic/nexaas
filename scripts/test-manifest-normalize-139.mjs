#!/usr/bin/env node
/**
 * Regression test for #139 — register-skill accepts contract.yaml natively.
 *
 * Pure test of `normalizeManifest` — exercises both the pass-through case
 * (framework-native skill.yaml) and the contract→manifest translation
 * (Nexmatic-style contract.yaml).
 *
 * Run: node --import tsx scripts/test-manifest-normalize-139.mjs
 */

import { normalizeManifest } from "../packages/cli/src/register-skill.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. Pass-through: framework-native skill.yaml ──────────────────
console.log("\n1. Framework-native skill.yaml passes through");
{
  const raw = {
    id: "crm/lead-sync-all",
    version: "1.0.0",
    triggers: [{ type: "cron", schedule: "*/30 * * * *" }],
    execution: { type: "shell", command: "do.sh", timeout: 600000 },
  };
  const m = normalizeManifest(raw);
  assert(m.id === "crm/lead-sync-all", "id unchanged");
  assert(m.version === "1.0.0", "version unchanged");
  assert(m.triggers?.[0]?.schedule === "*/30 * * * *", "triggers unchanged");
  assert(m.execution?.timeout === 600000, "timeout (ms) unchanged");
}

// ── 2. Contract: skill + category → id ────────────────────────────
console.log("\n2. contract.yaml: skill + category → id");
{
  const raw = {
    skill: "lead-sync-all",
    category: "crm",
    version: "1.0.0",
    schedule: "*/30 * * * *",
    execution: { type: "shell", command: "do.sh", timeout_seconds: 600 },
  };
  const m = normalizeManifest(raw);
  assert(m.id === "crm/lead-sync-all", `id assembled (got '${m.id}')`);
  assert(m.version === "1.0.0", "version preserved");
}

// ── 3. Contract: top-level schedule → cron trigger ────────────────
console.log("\n3. contract.yaml: top-level schedule → cron trigger");
{
  const raw = {
    skill: "marketing/email-broadcast",
    version: "0.1.0",
    schedule: "0 9 * * MON",
    execution: { type: "ai-skill" },
  };
  const m = normalizeManifest(raw);
  assert(Array.isArray(m.triggers), "triggers array created");
  assert(m.triggers?.length === 1, "one trigger");
  assert(m.triggers?.[0]?.type === "cron", "type=cron");
  assert(m.triggers?.[0]?.schedule === "0 9 * * MON", "schedule preserved");
}

// ── 4. Contract: timeout_seconds → timeout (ms) ───────────────────
console.log("\n4. contract.yaml: timeout_seconds → timeout (ms)");
{
  const raw = {
    skill: "ops/cleanup",
    category: "ops",
    version: "0.1.0",
    schedule: "0 3 * * *",
    execution: { type: "shell", command: "cleanup.sh", timeout_seconds: 600 },
  };
  const m = normalizeManifest(raw);
  assert(m.execution?.timeout === 600000, `600s → 600000ms (got ${m.execution?.timeout})`);
}

// ── 5. Contract with slash in `skill:` skips category prefix ──────
console.log("\n5. contract.yaml with category-prefixed skill: doesn't double-prefix");
{
  const raw = {
    skill: "hr/onboarding-intake",
    category: "hr",       // already in skill
    version: "0.1.0",
    schedule: "0 9 * * MON",
  };
  const m = normalizeManifest(raw);
  assert(m.id === "hr/onboarding-intake", `id stays single-prefix (got '${m.id}')`);
}

// ── 6. Contract without category falls back to bare skill ─────────
console.log("\n6. contract.yaml without category uses bare skill");
{
  const raw = {
    skill: "standalone",
    version: "0.1.0",
    schedule: "0 * * * *",
  };
  const m = normalizeManifest(raw);
  assert(m.id === "standalone", "id is the bare skill name");
}

// ── 7. Contract-only fields pass through (produces, outputs, etc.) ─
console.log("\n7. Contract-only fields pass through");
{
  const raw = {
    skill: "email-broadcast",
    category: "marketing",
    version: "0.1.0",
    schedule: "0 * * * *",
    produces: { type: "outbound_email" },
    outputs: ["scheduled_email"],
    tag_defaults: { approval_required: false },
    client_must_configure: ["postmark_api_key"],
    mcp_servers: ["email-outbound"],
    rag: { rooms: ["marketing.templates"] },
  };
  const m = normalizeManifest(raw);
  assert(m.id === "marketing/email-broadcast", "id translated");
  assert(m.produces?.type === "outbound_email", "produces passes through");
  assert(m.outputs?.[0] === "scheduled_email", "outputs passes through");
  assert(m.tag_defaults?.approval_required === false, "tag_defaults passes through");
  assert(Array.isArray(m.client_must_configure), "client_must_configure passes through");
  assert(Array.isArray(m.mcp_servers), "mcp_servers passes through");
  assert(m.rag?.rooms?.[0] === "marketing.templates", "rag passes through");
}

// ── 8. Explicit triggers array wins over schedule ─────────────────
console.log("\n8. Explicit triggers wins over top-level schedule");
{
  const raw = {
    skill: "hybrid",
    category: "x",
    version: "0.1.0",
    schedule: "0 * * * *",
    triggers: [{ type: "cron", schedule: "*/15 * * * *" }],
  };
  const m = normalizeManifest(raw);
  assert(m.triggers?.[0]?.schedule === "*/15 * * * *", "explicit triggers used");
  assert(m.triggers?.length === 1, "schedule did NOT add a second trigger");
}

// ── 9. Empty / malformed inputs ───────────────────────────────────
console.log("\n9. Empty / malformed");
{
  assert(normalizeManifest(null).id === undefined, "null → empty manifest");
  assert(normalizeManifest({}).id === undefined, "empty → empty manifest");
  // YAML parse fail upstream returns null/undefined; normalizeManifest shouldn't crash.
  assert(normalizeManifest(undefined).id === undefined, "undefined → empty manifest");
}

// ── 10. Contract with execution.timeout (ms) wins over timeout_seconds ─
console.log("\n10. execution.timeout (ms) wins over timeout_seconds");
{
  const raw = {
    skill: "x",
    category: "y",
    version: "0.1.0",
    schedule: "* * * * *",
    execution: { type: "shell", timeout: 30000, timeout_seconds: 999 },
  };
  const m = normalizeManifest(raw);
  assert(m.execution?.timeout === 30000, `explicit ms wins (got ${m.execution?.timeout})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
