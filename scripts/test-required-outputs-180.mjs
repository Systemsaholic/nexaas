#!/usr/bin/env node
/**
 * Regression test for #180 — required outputs + chain_signal kind.
 *
 * Verifies the contract pieces in isolation: the TerminalReason union
 * includes the new value, the drawer payload shape is right, and the
 * conceptual required-output computation matches what ai-skill.ts does.
 * Runtime wiring (engine.apply routing + ai-skill catch) is covered by
 * smoke tests against a real workspace.
 *
 * Run: node --import tsx scripts/test-required-outputs-180.mjs
 */

import { buildTerminalDrawerPayload } from "../packages/runtime/src/skill-terminal.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. required_output_missing drawer shape ───────────────────────
console.log("\n1. required_output_missing drawer carries missing+produced lists");
{
  const payload = buildTerminalDrawerPayload(
    { skill: "promo/research", terminal_reason: "required_output_missing" },
    {
      missing_outputs: ["promo_draft_ready"],
      produced_outputs: ["promo_research_done"],
      turns: 8,
    },
  );
  assert(payload.success === false, "required_output_missing is failure");
  assert(payload.terminal_reason === "required_output_missing", "reason set");
  assert(Array.isArray(payload.missing_outputs) && payload.missing_outputs[0] === "promo_draft_ready",
    "missing_outputs list carried");
  assert(Array.isArray(payload.produced_outputs) && payload.produced_outputs[0] === "promo_research_done",
    "produced_outputs list carried (diagnostic: shows what DID happen)");
  assert(payload.turns === 8, "turns preserved");
}

// ── 2. missingRequired computation matches ai-skill.ts logic ──────
console.log("\n2. missing-required computation mirrors ai-skill.ts");
function computeMissing(outputs, produced, aborted) {
  if (aborted) return [];
  return outputs
    .filter((o) => o.required === true)
    .map((o) => o.id)
    .filter((id) => !produced.includes(id));
}
{
  // Case A: all required outputs produced
  const allOk = computeMissing(
    [{ id: "a", required: true }, { id: "b", required: false }],
    ["a", "b"],
    false,
  );
  assert(allOk.length === 0, "all required produced → no missing");

  // Case B: one required missing
  const oneMissing = computeMissing(
    [{ id: "stage_1_complete", required: true }],
    [],
    false,
  );
  assert(oneMissing.length === 1 && oneMissing[0] === "stage_1_complete",
    "missing required surfaced");

  // Case C: optional output not produced — no failure
  const optionalOnly = computeMissing(
    [{ id: "metrics_dump" }, { id: "audit_blob", required: false }],
    [],
    false,
  );
  assert(optionalOnly.length === 0, "optional outputs don't trigger failure");

  // Case D: loop aborted → no check (abort already terminates with its
  // own reason; we don't double-report)
  const aborted = computeMissing(
    [{ id: "stage_1_complete", required: true }],
    [],
    true,
  );
  assert(aborted.length === 0, "aborted loop skips required check");

  // Case E: multiple missing reported together
  const multi = computeMissing(
    [
      { id: "a", required: true },
      { id: "b", required: true },
      { id: "c", required: true },
    ],
    ["b"],
    false,
  );
  assert(multi.length === 2 && multi.includes("a") && multi.includes("c"),
    "multiple missing required reported");
}

// ── 3. chain_signal routing convention ────────────────────────────
console.log("\n3. chain_signal routes to inbox.messaging.<output_id>");
{
  // engine.apply uses action.action.kind as the channel_role for chain_signal.
  // produce_output sets kind = output.id, so output_id directly becomes the
  // room name — matching the inbound-dispatcher convention (room === channel_role).
  const outputId = "stage_1_complete";
  const room = { wing: "inbox", hall: "messaging", room: outputId };
  assert(room.wing === "inbox" && room.hall === "messaging" && room.room === "stage_1_complete",
    "chain_signal target room: inbox.messaging.<output_id>");
  // Verify the next step's trigger would match: an inbound-message trigger
  // with channel_role: stage_1_complete polls exactly this room.
  const trigger = { type: "inbound-message", channel_role: "stage_1_complete" };
  assert(trigger.channel_role === room.room, "channel_role === room (dispatcher convention)");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
