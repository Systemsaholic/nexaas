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
  | "verification_failed" // ai-skill output verification failed required checks
  | "required_output_missing"; // ai-skill ended without producing a required output (#180)

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

/**
 * Filesystem path prefixes that indicate ephemeral storage. Manifests stored
 * under these are liable to vanish across reboots, systemd-tmpfiles cleanup,
 * or OOM-prompted /tmp sweeps — leaving the BullMQ scheduler ticking on a
 * dead repeatable that produces no run, no log, no drawer (#172).
 *
 * Trailing slash is intentional — without it `/tmpfoo` would falsely match.
 */
export const EPHEMERAL_PATH_PREFIXES = [
  "/tmp/",
  "/var/tmp/",
  "/run/",
  "/dev/shm/",
] as const;

/**
 * Returns true when the absolute path lives under an ephemeral filesystem
 * prefix. Also checks `$XDG_RUNTIME_DIR` at call time so container and
 * desktop-session configurations with non-default runtime dirs are caught.
 *
 * Caller is responsible for resolving relative paths first — we compare
 * against absolute prefixes, so passing `./tmp/foo` would not match.
 */
export function isEphemeralPath(absPath: string): boolean {
  if (!absPath) return false;
  for (const prefix of EPHEMERAL_PATH_PREFIXES) {
    if (absPath.startsWith(prefix)) return true;
  }
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && absPath.startsWith(xdgRuntime.endsWith("/") ? xdgRuntime : xdgRuntime + "/")) {
    return true;
  }
  return false;
}

/**
 * Detect whether a thrown error represents a prompt-overflow rejection from
 * the model provider (e.g. Anthropic returns 400 with a body that includes
 * "prompt is too long: <N> tokens > <M> maximum" when the assembled request
 * exceeds the context window).
 *
 * Used by the ai-skill catch block to classify the terminal_reason as
 * `prompt_overflow` rather than the generic `failed`, so dashboards and
 * watchdog skills can render this distinct failure mode (#173).
 *
 * Heuristic — Anthropic doesn't ship a typed error class for context
 * overflow, just a 400 with the message above. We match the message
 * pattern conservatively: must be a 400 AND mention "prompt is too long"
 * OR the broader "context length"/"context window" phrasing. False
 * positives are preferable to false negatives here — the worst case is
 * a non-overflow 400 mislabeled as overflow on the drawer, which still
 * surfaces as a failure (terminal_reason will be `prompt_overflow`
 * instead of `failed`, but `success` is false either way).
 */
export function isPromptOverflowError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  const message = (err as { message?: string }).message ?? "";
  if (status !== 400) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("prompt is too long") ||
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context")
  );
}

/**
 * Parse the token-count numbers out of Anthropic's prompt-overflow message
 * shape ("prompt is too long: 220148 tokens > 200000 maximum"). Returns
 * undefined when the message doesn't carry the pattern — the caller should
 * fall back to the plain error message in that case.
 */
export function extractPromptOverflowTokens(message: string): { estimated: number; maximum: number } | undefined {
  const match = message.match(/(\d{4,})\s*tokens?\s*>\s*(\d{4,})/i);
  if (!match || !match[1] || !match[2]) return undefined;
  const estimated = Number.parseInt(match[1], 10);
  const maximum = Number.parseInt(match[2], 10);
  if (Number.isNaN(estimated) || Number.isNaN(maximum)) return undefined;
  return { estimated, maximum };
}

/**
 * Map the agentic loop's stop reason (defined in models/agentic-loop.ts as
 * a deliberately narrow union) to the framework-wide TerminalReason.
 *
 * `end_turn` is the only stop reason that indicates a successful completion;
 * every other value is an abort. The narrow loop union is intentional — the
 * loop only knows about its own limits — so this adapter sits at the
 * ai-skill executor boundary where loop-internal reasons become framework
 * terminal states.
 */
export function terminalReasonFromAgenticStopReason(
  stopReason:
    | "end_turn"
    | "max_turns"
    | "spend_cap"
    | "input_token_cap"
    | "output_token_cap"
    | "repetition"
    | "error_streak",
): TerminalReason {
  switch (stopReason) {
    case "end_turn":         return "ok";
    case "max_turns":        return "max_turns";
    case "spend_cap":        return "spend_cap";
    case "input_token_cap":  return "input_token_cap";
    case "output_token_cap": return "output_token_cap";
    case "repetition":       return "repetition";
    case "error_streak":     return "error_streak";
  }
}
