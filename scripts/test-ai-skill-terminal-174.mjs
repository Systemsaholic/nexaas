#!/usr/bin/env node
/**
 * Regression test for #174 — ai-skill aborts (spend_cap, etc.) and
 * exceptions must produce a terminal drawer with the canonical shape.
 *
 * Pure tests of:
 *   - terminalReasonFromAgenticStopReason() — covers all 7 stop reasons
 *   - buildTerminalDrawerPayload() shape for the three ai-skill exit paths
 *     (loop abort with spend_cap, preflight-failed, generic exception)
 *
 * Behavioural assertion (the drawer is actually written) is covered by
 * runtime smoke tests — these tests just verify the shape contract holds
 * for the payload data each call site assembles.
 *
 * Run: node --import tsx scripts/test-ai-skill-terminal-174.mjs
 */

import {
  buildTerminalDrawerPayload,
  terminalReasonFromAgenticStopReason,
} from "../packages/runtime/src/skill-terminal.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. AgenticStopReason → TerminalReason mapping ─────────────────
console.log("\n1. terminalReasonFromAgenticStopReason — all 7 stop reasons map");
{
  assert(terminalReasonFromAgenticStopReason("end_turn") === "ok",
    "end_turn → ok (only success value)");
  assert(terminalReasonFromAgenticStopReason("max_turns") === "max_turns",
    "max_turns passes through");
  assert(terminalReasonFromAgenticStopReason("spend_cap") === "spend_cap",
    "spend_cap passes through");
  assert(terminalReasonFromAgenticStopReason("input_token_cap") === "input_token_cap",
    "input_token_cap passes through");
  assert(terminalReasonFromAgenticStopReason("output_token_cap") === "output_token_cap",
    "output_token_cap passes through");
  assert(terminalReasonFromAgenticStopReason("repetition") === "repetition",
    "repetition passes through");
  assert(terminalReasonFromAgenticStopReason("error_streak") === "error_streak",
    "error_streak passes through");
}

// ── 2. spend_cap drawer carries the cap vs actual delta ────────────
console.log("\n2. spend_cap drawer carries cap_usd + actual_usd (regression: #174)");
{
  // Simulate the payload assembly path in ai-skill.ts when the loop
  // aborts on spend_cap. Includes the extras the executor adds only
  // when terminal_reason === 'spend_cap'.
  const stopReason = "spend_cap";
  const terminalReason = terminalReasonFromAgenticStopReason(stopReason);
  const limits = { maxSpendUsd: 1.45 };
  const result = { costUsd: 1.46, inputTokens: 12345, outputTokens: 678, turns: 7, toolCalls: { length: 12 } };

  const payload = buildTerminalDrawerPayload(
    { skill: "marketing/freshness-watchdog", terminal_reason: terminalReason },
    {
      stop_reason: stopReason,
      aborted: true,
      turns: result.turns,
      tool_calls: result.toolCalls.length,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd: result.costUsd,
      ...(terminalReason === "spend_cap" && limits.maxSpendUsd !== undefined
        ? { spend_cap_usd: limits.maxSpendUsd, spend_actual_usd: result.costUsd }
        : {}),
    },
  );

  assert(payload.success === false, "spend_cap drawer is success=false");
  assert(payload.terminal_reason === "spend_cap", "terminal_reason='spend_cap'");
  assert(payload.spend_cap_usd === 1.45, "spend_cap_usd carries manifest limit");
  assert(payload.spend_actual_usd === 1.46, "spend_actual_usd carries result cost");
  assert(payload.cost_usd === 1.46, "legacy cost_usd retained for backward compat");
  assert(payload.aborted === true, "legacy aborted field retained");
  assert(payload.stop_reason === "spend_cap", "legacy stop_reason retained");
}

// ── 3. max_turns drawer carries the configured cap ─────────────────
console.log("\n3. max_turns drawer carries max_turns extra");
{
  const stopReason = "max_turns";
  const terminalReason = terminalReasonFromAgenticStopReason(stopReason);
  const limits = { maxTurns: 10 };

  const payload = buildTerminalDrawerPayload(
    { skill: "ops/long-task", terminal_reason: terminalReason },
    {
      ...(terminalReason === "max_turns" && limits.maxTurns !== undefined
        ? { max_turns: limits.maxTurns }
        : {}),
    },
  );
  assert(payload.max_turns === 10, "max_turns carries the configured cap");
  assert(payload.success === false, "max_turns is a failure");
}

// ── 4. preflight-failed drawer shape ───────────────────────────────
console.log("\n4. preflight-failed exit ≥ 2 drawer shape");
{
  const payload = buildTerminalDrawerPayload(
    { skill: "ops/example", terminal_reason: "failed", duration_ms: 250 },
    { preflight_exit_code: 2, error: "preflight: db unreachable" },
  );
  assert(payload.success === false, "preflight-failed is success=false");
  assert(payload.terminal_reason === "failed", "terminal_reason='failed'");
  assert(payload.preflight_exit_code === 2, "preflight_exit_code carried");
  assert(payload.duration_ms === 250, "duration_ms preserved");
}

// ── 5. catch-block exception drawer (rate_limited vs failed) ───────
console.log("\n5. catch-block exception → rate_limited or failed");
{
  // 429 from Anthropic
  const rateLimited = buildTerminalDrawerPayload(
    { skill: "ops/api-skill", terminal_reason: "rate_limited" },
    { error: "rate_limit_exceeded", status: 429 },
  );
  assert(rateLimited.terminal_reason === "rate_limited", "429 → rate_limited");
  assert(rateLimited.success === false, "rate_limited is failure");
  assert(rateLimited.status === 429, "status preserved");

  // Generic exception (e.g. prompt-too-long, MCP transport error)
  const generic = buildTerminalDrawerPayload(
    { skill: "ops/big-skill", terminal_reason: "failed" },
    { error: "prompt is too long: 220148 tokens > 200000 maximum", status: null },
  );
  assert(generic.terminal_reason === "failed", "generic exception → failed");
  assert(generic.status === null, "status is null for non-HTTP errors");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
