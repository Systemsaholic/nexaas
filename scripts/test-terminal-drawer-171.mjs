#!/usr/bin/env node
/**
 * Regression test for #171 — shell-skill drawer must always include BOTH
 * stdout_preview and stderr_preview, plus a terminal_reason discriminator.
 *
 * Pure test of `buildTerminalDrawerPayload` — covers the canonical shape
 * for the four reasons shell-skill produces today (ok, failed, timeout)
 * plus a sanity case for the success/terminal_reason invariant.
 *
 * Run: node --import tsx scripts/test-terminal-drawer-171.mjs
 */

import {
  buildTerminalDrawerPayload,
  STREAM_PREVIEW_CAP_BYTES,
} from "../packages/runtime/src/skill-terminal.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. ok payload ────────────────────────────────────────────────
console.log("\n1. terminal_reason: 'ok' produces success=true");
{
  const p = buildTerminalDrawerPayload(
    { skill: "ops/example", terminal_reason: "ok", duration_ms: 42 },
    {
      command: "scripts/example.py",
      exit_code: 0,
      stdout_preview: "ran ok\n",
      stderr_preview: "WARNING: degraded\n",
    },
  );
  assert(p.skill === "ops/example", "skill set");
  assert(p.success === true, "success=true for ok");
  assert(p.terminal_reason === "ok", "terminal_reason='ok'");
  assert(p.duration_ms === 42, "duration_ms preserved");
  assert(p.stdout_preview === "ran ok\n", "stdout_preview captured");
  assert(p.stderr_preview === "WARNING: degraded\n", "stderr_preview captured");
  assert(p.exit_code === 0, "exit_code in extras");
}

// ── 2. failed payload ────────────────────────────────────────────
console.log("\n2. terminal_reason: 'failed' produces success=false");
{
  const p = buildTerminalDrawerPayload(
    { skill: "ops/example", terminal_reason: "failed", duration_ms: 100 },
    {
      command: "boom.sh",
      exit_code: 2,
      stdout_preview: "partial output before failure",
      stderr_preview: "Traceback ...\nValueError",
    },
  );
  assert(p.success === false, "success=false for failed");
  assert(p.terminal_reason === "failed", "terminal_reason='failed'");
  // The fix for #171: failure path MUST surface stdout too. Previously the
  // drawer dropped stdout entirely on failure.
  assert(typeof p.stdout_preview === "string" && p.stdout_preview.length > 0,
    "failure drawer includes stdout_preview (regression: #171)");
  assert(typeof p.stderr_preview === "string" && p.stderr_preview.length > 0,
    "failure drawer includes stderr_preview");
}

// ── 3. timeout discriminator ─────────────────────────────────────
console.log("\n3. terminal_reason: 'timeout' distinguishable from 'failed'");
{
  const p = buildTerminalDrawerPayload(
    { skill: "ops/wedged", terminal_reason: "timeout", duration_ms: 120000 },
    { command: "sleep 9999", exit_code: 137 },
  );
  assert(p.terminal_reason === "timeout", "timeout reason preserved");
  assert(p.success === false, "timeout is a failure");
}

// ── 4. success/reason invariant ──────────────────────────────────
console.log("\n4. canonical fields cannot be clobbered by extras");
{
  const p = buildTerminalDrawerPayload(
    { skill: "ops/x", terminal_reason: "spend_cap" },
    // Hostile extras trying to lie about the outcome.
    { success: true, terminal_reason: "ok", skill: "tampered" },
  );
  assert(p.success === false, "spend_cap → success=false even with extras.success=true");
  assert(p.terminal_reason === "spend_cap", "terminal_reason wins the merge");
  assert(p.skill === "ops/x", "skill wins the merge");
}

// ── 5. duration_ms is optional ───────────────────────────────────
console.log("\n5. duration_ms is omitted when not provided");
{
  const p = buildTerminalDrawerPayload(
    { skill: "ops/x", terminal_reason: "manifest_missing" },
  );
  assert(!("duration_ms" in p), "no duration_ms when caller omits it");
  assert(p.terminal_reason === "manifest_missing", "reason preserved");
}

// ── 6. preview cap exported ──────────────────────────────────────
console.log("\n6. STREAM_PREVIEW_CAP_BYTES exported and sane");
{
  assert(STREAM_PREVIEW_CAP_BYTES === 2048, "cap is 2KB (up from 500B legacy)");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
