/**
 * Generic agent task — runs any workspace agent via Claude Code CLI.
 *
 * Triggered on-demand from the Trigger.dev dashboard or via SDK.
 * Replaces manual `claude --print` invocations with queued, retried, observable runs.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { runClaude, type ClaudeResult } from "../lib/claude.js";

export const runAgent = task({
  id: "run-agent",
  maxDuration: 600, // 10 min — generic agent safety cap
  queue: {
    name: "claude-agents",
    concurrencyLimit: 3, // Match current Nexaas worker pool
  },
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
  },
  run: async (payload: {
    agent?: string;
    prompt: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<ClaudeResult> => {
    logger.info("Starting agent run", {
      agent: payload.agent || "default",
      promptLength: payload.prompt.length,
    });

    const result = await runClaude({
      agent: payload.agent,
      prompt: payload.prompt,
      model: payload.model,
      timeoutMs: payload.timeoutMs,
    });

    if (!result.success) {
      // Throw to trigger retry
      throw new Error(`Agent run failed: ${result.error}`);
    }

    logger.info("Agent run completed", {
      agent: payload.agent || "default",
      durationMs: result.durationMs,
      outputLength: result.output.length,
      tokens: result.tokens,
    });

    return result;
  },
});
