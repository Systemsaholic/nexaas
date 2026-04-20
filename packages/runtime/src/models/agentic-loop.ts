/**
 * Agentic loop — multi-turn tool-use execution with Claude.
 *
 * For skills that need Claude to call MCP tools iteratively:
 * 1. Send messages + tools to Claude
 * 2. Claude responds with tool_use blocks
 * 3. Execute each tool call against the MCP server
 * 4. Send results back as tool_result messages
 * 5. Repeat until Claude stops, or a guardrail fires.
 *
 * Guardrails (all optional, all off unless caller provides a limit):
 *   - maxTurns                               — hard turn ceiling
 *   - maxSpendUsd (requires modelPricing)    — cumulative API spend cap
 *   - maxInputTokens / maxOutputTokens       — cumulative token caps
 *   - maxConsecutiveIdenticalToolCalls       — repetition detector (default 3)
 *   - maxConsecutiveErrors                   — tool-error streak detector (default 3)
 */

import Anthropic from "@anthropic-ai/sdk";
import { appendWal } from "@nexaas/palace";
import type { ModelAction } from "./gateway.js";
import { isRetryable as isRetryableAnthropicError } from "./providers/anthropic.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    // maxRetries: 0 — the SDK's built-in retry would hide 429s from our
    // queue-pause path (#27). Our own retryWithBackoff below handles the
    // retryable-but-not-429 cases; 429s propagate unretried so the worker
    // layer can pause the queue for the cooldown window.
    // timeout: 60s — fail fast on network hangs; #32 showed the default
    // 10min timeout leaves stalled requests hanging skill runs for minutes.
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 0,
      timeout: 60_000,
    });
  }
  return _client;
}

/**
 * Retry wrapper for the single `client.messages.create` call.
 *
 * Retries on connection errors and 5xx (incl. 529 overloaded) with
 * exponential backoff + jitter. 429s are NEVER retried here — they
 * propagate unretried so the worker's queue-pause path (#27) can
 * react to the rate-limit headers. All other errors bubble immediately.
 *
 * Addresses #32: transient network blips (~1-3/hr at baseline) were
 * killing runs outright because the call wasn't wrapped.
 */
async function retryMessagesCreate(
  fn: () => Promise<Anthropic.Message>,
  opts: { maxAttempts?: number; baseMs?: number; maxMs?: number } = {},
): Promise<Anthropic.Message> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;

      // 429 → propagate immediately so the worker can pause the queue.
      if (status === 429) throw err;

      // Non-retryable errors bubble immediately.
      if (!isRetryableAnthropicError(err)) throw err;

      // Last attempt — out of budget, surface the error.
      if (attempt === maxAttempts) throw err;

      // Exponential backoff with ±25% jitter, capped at maxMs.
      const base = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const delay = Math.max(100, Math.round(base + jitter));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolExecutor {
  (toolName: string, input: Record<string, unknown>): Promise<string>;
}

export type AgenticStopReason =
  | "end_turn"
  | "max_turns"
  | "spend_cap"
  | "input_token_cap"
  | "output_token_cap"
  | "repetition"
  | "error_streak";

export interface AgenticLimits {
  maxTurns?: number;
  maxSpendUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /**
   * Per-turn `max_tokens` sent to the Anthropic API. Bounds the size of a
   * single assistant response (including any tool_use block). Too low and
   * large string params (reports, long content) get truncated mid-JSON,
   * producing malformed tool calls — see issue #26.
   */
  maxOutputTokensPerTurn?: number;
  maxConsecutiveIdenticalToolCalls?: number;
  maxConsecutiveErrors?: number;
}

export interface AgenticModelPricing {
  inputCostPerM: number;
  outputCostPerM: number;
}

export interface AgenticResult {
  content: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  actions: ModelAction[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  stopReason: AgenticStopReason;
  aborted: boolean;
}

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_CONSECUTIVE_IDENTICAL = 3;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_MAX_OUTPUT_TOKENS_PER_TURN = 16000;

function canonicalize(input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = input[k];
  try {
    return JSON.stringify(obj);
  } catch {
    return String(Math.random());
  }
}

function costOf(
  pricing: AgenticModelPricing | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!pricing) return 0;
  const c = pricing.inputCostPerM * (inputTokens / 1_000_000)
    + pricing.outputCostPerM * (outputTokens / 1_000_000);
  return Math.round(c * 10000) / 10000;
}

export async function runAgenticLoop(params: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: McpTool[];
  executeTool: ToolExecutor;
  workspace: string;
  runId: string;
  skillId: string;
  limits?: AgenticLimits;
  modelPricing?: AgenticModelPricing;
  /** @deprecated use `limits.maxTurns` */
  maxTurns?: number;
}): Promise<AgenticResult> {
  const { model, system, tools, executeTool, workspace, runId, skillId, modelPricing } = params;
  const limits: AgenticLimits = params.limits ?? {};
  const maxTurns = limits.maxTurns ?? params.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxIdentical = limits.maxConsecutiveIdenticalToolCalls ?? DEFAULT_MAX_CONSECUTIVE_IDENTICAL;
  const maxErrors = limits.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
  const maxTokensPerTurn = limits.maxOutputTokensPerTurn ?? DEFAULT_MAX_OUTPUT_TOKENS_PER_TURN;

  const client = getClient();

  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));

  let messages = [...params.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  const allToolCalls: AgenticResult["toolCalls"] = [];
  let finalContent = "";

  let lastToolFingerprint: string | null = null;
  let identicalStreak = 0;
  let errorStreak = 0;

  let stopReason: AgenticStopReason = "max_turns";
  let aborted = true;

  const overSpendCap = () =>
    limits.maxSpendUsd != null
      && modelPricing != null
      && costOf(modelPricing, totalInputTokens, totalOutputTokens) >= limits.maxSpendUsd;
  const overInputCap = () =>
    limits.maxInputTokens != null && totalInputTokens >= limits.maxInputTokens;
  const overOutputCap = () =>
    limits.maxOutputTokens != null && totalOutputTokens >= limits.maxOutputTokens;

  while (turns < maxTurns) {
    turns++;

    const response = await retryMessagesCreate(() => client.messages.create({
      model,
      max_tokens: maxTokensPerTurn,
      system,
      messages,
      tools: anthropicTools,
    }));

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    let turnText = "";
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        turnText += block.text;
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    finalContent = turnText;

    // Detect output-cap truncation mid-tool_use — see issue #26. The tool_use
    // block's JSON is cut off, which downstream reads as a malformed call and
    // the agent confabulates an explanation. Log loudly so operators notice.
    const truncatedMidToolUse =
      response.stop_reason === "max_tokens" && toolUseBlocks.length > 0;
    if (truncatedMidToolUse) {
      console.warn(
        `[nexaas] agentic-loop turn ${turns} hit max_tokens (${maxTokensPerTurn}) mid-tool_use — ` +
        `tool call likely malformed. Raise limits.max_output_tokens_per_turn in the skill manifest.`,
      );
      await appendWal({
        workspace,
        op: "agentic_truncated",
        actor: `skill:${skillId}`,
        payload: {
          run_id: runId,
          turn: turns,
          max_tokens: maxTokensPerTurn,
          output_tokens: response.usage.output_tokens,
          tools_attempted: toolUseBlocks.map((t) => t.name),
        },
      });
    }

    // Natural stop — agent declared completion.
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      await appendWal({
        workspace,
        op: "agentic_turn",
        actor: `skill:${skillId}`,
        payload: {
          run_id: runId,
          turn: turns,
          tool_calls: 0,
          stop_reason: response.stop_reason,
          final: true,
        },
      });
      stopReason = "end_turn";
      aborted = false;
      break;
    }

    // Execute tool calls — track error streak and repetition as we go.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnHadSuccess = false;
    const turnToolRecords: Array<{
      name: string;
      input_preview: string;
      result_preview: string;
      error: boolean;
    }> = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;
      const fingerprint = `${toolUse.name}:${canonicalize(input)}`;

      if (fingerprint === lastToolFingerprint) {
        identicalStreak++;
      } else {
        identicalStreak = 1;
        lastToolFingerprint = fingerprint;
      }

      let result: string;
      let wasError = false;
      try {
        result = await executeTool(toolUse.name, input);
        if (typeof result === "string" && result.startsWith("Error:")) {
          wasError = true;
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        wasError = true;
      }

      if (wasError) {
        errorStreak++;
      } else {
        errorStreak = 0;
        turnHadSuccess = true;
      }

      allToolCalls.push({ name: toolUse.name, input, result: result.slice(0, 500) });
      turnToolRecords.push({
        name: toolUse.name,
        input_preview: canonicalize(input).slice(0, 500),
        result_preview: result.slice(0, 500),
        error: wasError,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    await appendWal({
      workspace,
      op: "agentic_turn",
      actor: `skill:${skillId}`,
      payload: {
        run_id: runId,
        turn: turns,
        tool_calls: turnToolRecords,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        identical_streak: identicalStreak,
        error_streak: errorStreak,
      },
    });

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    // Guardrail checks — evaluated after the turn so we always record what happened.
    if (identicalStreak >= maxIdentical) { stopReason = "repetition"; break; }
    if (errorStreak >= maxErrors) { stopReason = "error_streak"; break; }
    if (overSpendCap()) { stopReason = "spend_cap"; break; }
    if (overInputCap()) { stopReason = "input_token_cap"; break; }
    if (overOutputCap()) { stopReason = "output_token_cap"; break; }

    // Reset error streak if the turn produced at least one successful tool call —
    // a mix of pass/fail in the same turn shouldn't nuke the run.
    if (turnHadSuccess) errorStreak = 0;
  }

  if (turns >= maxTurns && stopReason === "max_turns") {
    aborted = true;
  }

  if (stopReason !== "end_turn") {
    await appendWal({
      workspace,
      op: "agentic_aborted",
      actor: `skill:${skillId}`,
      payload: {
        run_id: runId,
        turn: turns,
        stop_reason: stopReason,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cost_usd: costOf(modelPricing, totalInputTokens, totalOutputTokens),
      },
    });
  }

  return {
    content: finalContent,
    toolCalls: allToolCalls,
    actions: [],
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costUsd: costOf(modelPricing, totalInputTokens, totalOutputTokens),
    turns,
    stopReason,
    aborted,
  };
}
