/**
 * Workspace-level rate-limit backoff for BullMQ queues.
 *
 * When one skill hits a 429 from Anthropic (org-wide TPM cap), pausing
 * just that skill isn't enough — every other queued ai-skill will hit
 * the same cap and fail the same way. This module pauses the whole
 * workspace queue for the cooldown window declared in the response
 * headers, then auto-resumes. See issue #27.
 */

import { appendWal } from "@nexaas/palace";
import { getSkillQueue } from "./queues.js";

const _activePauses = new Map<string, { timer: NodeJS.Timeout; resumeAt: number }>();
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number };
  return e.status === 429;
}

export function extractCooldownMs(err: unknown): number {
  const headers = (err as { headers?: { get?: (k: string) => string | null } }).headers;
  if (!headers?.get) return DEFAULT_COOLDOWN_MS;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const asSeconds = parseFloat(retryAfter);
    if (!Number.isNaN(asSeconds) && asSeconds > 0) {
      return Math.min(asSeconds * 1000, MAX_COOLDOWN_MS);
    }
    const asDate = new Date(retryAfter).getTime();
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return Math.min(delta, MAX_COOLDOWN_MS);
    }
  }

  // Anthropic-specific reset headers are ISO dates — pick the latest.
  const resetHeaders = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
    "anthropic-ratelimit-tokens-reset",
  ];
  let maxDelta = 0;
  for (const h of resetHeaders) {
    const v = headers.get(h);
    if (!v) continue;
    const ts = new Date(v).getTime();
    if (!Number.isNaN(ts)) {
      const delta = ts - Date.now();
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  if (maxDelta > 0) return Math.min(maxDelta, MAX_COOLDOWN_MS);

  return DEFAULT_COOLDOWN_MS;
}

export async function pauseQueueFor(
  workspaceId: string,
  cooldownMs: number,
  reason: string,
): Promise<void> {
  const existing = _activePauses.get(workspaceId);
  if (existing) {
    // Extend if the new cooldown outlasts the active one.
    const newResumeAt = Date.now() + cooldownMs;
    if (newResumeAt > existing.resumeAt) {
      clearTimeout(existing.timer);
      _activePauses.delete(workspaceId);
    } else {
      return;
    }
  }

  const queue = getSkillQueue(workspaceId);
  try {
    await queue.pause();
  } catch (err) {
    console.error(`[nexaas] failed to pause queue ${workspaceId}:`, err);
    return;
  }

  const resumeAt = Date.now() + cooldownMs;
  await appendWal({
    workspace: workspaceId,
    op: "queue_paused",
    actor: "rate-limit-backoff",
    payload: {
      reason,
      cooldown_ms: cooldownMs,
      resume_at: new Date(resumeAt).toISOString(),
    },
  });
  console.warn(
    `[nexaas] queue ${workspaceId} paused for ${Math.round(cooldownMs / 1000)}s (${reason})`,
  );

  const timer = setTimeout(async () => {
    try {
      await queue.resume();
      await appendWal({
        workspace: workspaceId,
        op: "queue_resumed",
        actor: "rate-limit-backoff",
        payload: { after_ms: cooldownMs },
      });
      console.log(`[nexaas] queue ${workspaceId} resumed after ${Math.round(cooldownMs / 1000)}s`);
    } catch (err) {
      console.error(`[nexaas] failed to resume queue ${workspaceId}:`, err);
    } finally {
      _activePauses.delete(workspaceId);
    }
  }, cooldownMs);

  _activePauses.set(workspaceId, { timer, resumeAt });
}

export function isQueuePaused(workspaceId: string): boolean {
  return _activePauses.has(workspaceId);
}
