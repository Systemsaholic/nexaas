/**
 * Terminal-drawer contract — every skill run, whatever its outcome, MUST
 * produce a drawer that names *why* it ended. This file owns the discriminator
 * values and a builder that keeps the payload shape consistent across the
 * shell and ai-skill executors plus the scheduler fire path.
 *
 * Filed in response to a cluster of silent-failure reports (#171, #172, #173,
 * #174): scheduler ticks, BullMQ job completes, palace is empty. The fix is
 * structural — "no drawer" must stop being a representable terminal state.
 *
 * Call sites still own their own writeDrawer + appendWal + runTracker calls
 * because the surrounding context (room resolution, WAL op name, run-tracker
 * state transition) differs per executor. This module only standardizes the
 * payload shape so the dashboard and watchdog skills can render any terminal
 * state without per-executor knowledge.
 */

/**
 * The reason a skill run reached its terminal state. `ok` is the only success
 * value; everything else is a failure mode the caller is expected to surface.
 *
 * Discriminator values are kebab-case for legibility in the dashboard and
 * stable as a contract — dashboards and watchdog skills should be able to
 * key off these names.
 */
export type TerminalReason =
  | "ok"               // shell exit 0, agentic loop end_turn
  | "failed"           // shell non-zero exit, generic ai-skill error
  | "timeout"          // shell command exceeded its timeout
  | "spend_cap"        // agentic loop exceeded maxSpendUsd
  | "input_token_cap"  // agentic loop exceeded maxInputTokens
  | "output_token_cap" // agentic loop exceeded maxOutputTokens
  | "repetition"       // agentic loop detected identical-tool-call streak
  | "error_streak"     // agentic loop hit max consecutive tool errors
  | "max_turns"        // agentic loop hit maxTurns
  | "prompt_overflow"  // model rejected request as too long (#173)
  | "rate_limited"     // 429 from model provider
  | "manifest_missing" // scheduler fired but manifest file is gone (#172)
  | "verification_failed"; // ai-skill output verification failed required checks

export interface TerminalDrawerPayload {
  skill: string;
  success: boolean;
  terminal_reason: TerminalReason;
  duration_ms?: number;
  /** Reason-specific extras — kept as a flat record so the dashboard can render
   *  per-reason fields without a deep schema. Callers are responsible for any
   *  truncation (e.g. stdout/stderr previews capped at 2KB). */
  [extra: string]: unknown;
}

/**
 * Build a terminal-drawer payload with the canonical shape. Pass extras as the
 * second arg; the helper enforces `success` matches `terminal_reason === 'ok'`
 * so call sites can't accidentally write `success: true` with a failure reason.
 */
export function buildTerminalDrawerPayload(
  base: { skill: string; terminal_reason: TerminalReason; duration_ms?: number },
  extras: Record<string, unknown> = {},
): TerminalDrawerPayload {
  // Spread extras FIRST so canonical fields win the merge — callers can't
  // pass `success: true` alongside `terminal_reason: "spend_cap"` and lie
  // about outcome. The shell-skill drawer is the only audit signal for a
  // failed run; an extras-clobber would silently flip a failure to success.
  return {
    ...extras,
    skill: base.skill,
    terminal_reason: base.terminal_reason,
    success: base.terminal_reason === "ok",
    ...(base.duration_ms !== undefined ? { duration_ms: base.duration_ms } : {}),
  };
}

/** Default cap (bytes) for stdout/stderr previews on shell-skill drawers.
 *  Up from the original 500B — operators reported losing diagnostic context
 *  when scripts emitted multi-line warnings before exiting (#171). 2KB is
 *  big enough for a typical traceback or warning paragraph and still small
 *  enough that drawer payloads stay rendering-friendly. */
export const STREAM_PREVIEW_CAP_BYTES = 2048;
