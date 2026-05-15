#!/usr/bin/env node
/**
 * Regression test for #173 — ai-skill prompt-overflow classifier.
 *
 * Pure tests of `isPromptOverflowError()` and `extractPromptOverflowTokens()`.
 * The wiring inside ai-skill.ts's catch block is covered by smoke tests.
 *
 * Run: node --import tsx scripts/test-prompt-overflow-173.mjs
 */

import {
  isPromptOverflowError,
  extractPromptOverflowTokens,
  buildTerminalDrawerPayload,
} from "../packages/runtime/src/skill-terminal.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. classifier matches known Anthropic shapes ──────────────────
console.log("\n1. isPromptOverflowError() matches Anthropic 400 overflow shapes");
{
  const real = Object.assign(new Error("prompt is too long: 220148 tokens > 200000 maximum"), { status: 400 });
  assert(isPromptOverflowError(real) === true,
    "exact Anthropic 'prompt is too long' phrasing → true");

  const ctxLen = Object.assign(new Error("Bad Request: context length exceeded"), { status: 400 });
  assert(isPromptOverflowError(ctxLen) === true,
    "alternate phrasing 'context length' → true");

  const ctxWin = Object.assign(new Error("Request exceeds the context window for this model"), { status: 400 });
  assert(isPromptOverflowError(ctxWin) === true,
    "'context window' phrasing → true");

  const maxCtx = Object.assign(new Error("payload exceeds maximum context length of 200000"), { status: 400 });
  assert(isPromptOverflowError(maxCtx) === true,
    "'maximum context' phrasing → true");
}

// ── 2. classifier rejects non-overflow errors ─────────────────────
console.log("\n2. isPromptOverflowError() does NOT match unrelated failures");
{
  const rateLimit = Object.assign(new Error("rate_limit_exceeded"), { status: 429 });
  assert(isPromptOverflowError(rateLimit) === false,
    "429 rate limit → false (not 400)");

  const auth = Object.assign(new Error("authentication failed"), { status: 401 });
  assert(isPromptOverflowError(auth) === false,
    "401 auth failure → false");

  const generic400 = Object.assign(new Error("invalid_request_error: missing field"), { status: 400 });
  assert(isPromptOverflowError(generic400) === false,
    "400 without prompt-too-long phrasing → false");

  const stringErr = "plain string error";
  assert(isPromptOverflowError(stringErr) === false,
    "non-object error → false");

  assert(isPromptOverflowError(null) === false, "null → false");
  assert(isPromptOverflowError(undefined) === false, "undefined → false");
}

// ── 3. token-count parser ─────────────────────────────────────────
console.log("\n3. extractPromptOverflowTokens() parses Anthropic message shape");
{
  const m = extractPromptOverflowTokens("prompt is too long: 220148 tokens > 200000 maximum");
  assert(m?.estimated === 220148, "parsed estimated token count");
  assert(m?.maximum === 200000, "parsed maximum token count");

  const lowerCase = extractPromptOverflowTokens("prompt is too long: 12345 TOKENS > 8192 maximum");
  assert(lowerCase?.estimated === 12345, "case-insensitive match");

  const noNumbers = extractPromptOverflowTokens("prompt is too long");
  assert(noNumbers === undefined, "no numbers → undefined");

  const wrongShape = extractPromptOverflowTokens("something completely unrelated");
  assert(wrongShape === undefined, "unrelated message → undefined");
}

// ── 4. integration: catch-block payload assembly ──────────────────
console.log("\n4. catch-block payload uses prompt_overflow with diagnostics");
{
  // Simulate the assembly path in ai-skill.ts catch block when the
  // model API returns the prompt-too-long 400.
  const err = Object.assign(new Error("prompt is too long: 220148 tokens > 200000 maximum"), { status: 400 });
  const isOverflow = isPromptOverflowError(err);
  const tokens = extractPromptOverflowTokens(err.message);
  const allToolsLength = 105; // groundhogg(52) + promotions(53) per #173 repro
  const mcpServers = ["groundhogg", "promotions"];

  const payload = buildTerminalDrawerPayload(
    { skill: "marketing/lead-sync-with-promos", terminal_reason: "prompt_overflow" },
    {
      error: err.message.slice(0, 2048),
      status: 400,
      ...(isOverflow ? { tool_count: allToolsLength, mcp_servers: mcpServers, ...(tokens ?? {}) } : {}),
    },
  );

  assert(payload.terminal_reason === "prompt_overflow",
    "terminal_reason classified as prompt_overflow");
  assert(payload.success === false, "prompt_overflow is failure");
  assert(payload.tool_count === 105, "tool_count carried (regression: #173 repro)");
  assert(Array.isArray(payload.mcp_servers) && payload.mcp_servers.length === 2,
    "mcp_servers list carried for correlation");
  assert(payload.estimated === 220148, "parsed estimated tokens on drawer");
  assert(payload.maximum === 200000, "parsed maximum tokens on drawer");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
