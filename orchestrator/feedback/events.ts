/**
 * Feedback Events — stores all feedback with delta capture.
 *
 * Architecture Guide v4 §7.3
 *
 * Every feedback event is stored from day one. The delta field
 * captures the diff between what Claude produced and what the
 * human actually sent — this is the primary learning signal.
 */

import { query } from "../db.js";
import { logger } from "@trigger.dev/sdk/v3";

export type FeedbackSource = "user" | "agent" | "operator";
export type FeedbackType = "approve" | "reject" | "edit" | "timeout" | "verify-pass" | "verify-fail";

export interface FeedbackEvent {
  taskRunId?: string;
  workspaceId: string;
  skillId?: string;
  gateId?: string;
  source: FeedbackSource;
  originalOutput?: string;
  feedbackType: FeedbackType;
  feedbackValue?: string;
  editedOutput?: string;
  downstreamAction?: string;
}

/**
 * Compute delta between original and edited output.
 * Returns a structured diff showing what changed.
 */
function computeDelta(original: string | undefined, edited: string | undefined): Record<string, unknown> | null {
  if (!original || !edited) return null;
  if (original === edited) return { changed: false };

  const originalLines = original.split("\n");
  const editedLines = edited.split("\n");

  const added: string[] = [];
  const removed: string[] = [];

  // Simple line-level diff
  const originalSet = new Set(originalLines);
  const editedSet = new Set(editedLines);

  for (const line of editedLines) {
    if (!originalSet.has(line) && line.trim()) added.push(line);
  }
  for (const line of originalLines) {
    if (!editedSet.has(line) && line.trim()) removed.push(line);
  }

  return {
    changed: true,
    added,
    removed,
    originalLength: original.length,
    editedLength: edited.length,
    changePercent: Math.round(Math.abs(edited.length - original.length) / Math.max(original.length, 1) * 100),
  };
}

/**
 * Store a feedback event. Called after every approval, rejection, edit, or verification.
 */
export async function storeFeedbackEvent(event: FeedbackEvent): Promise<string | null> {
  try {
    const delta = computeDelta(event.originalOutput, event.editedOutput);

    const result = await query(
      `INSERT INTO feedback_events
       (task_run_id, workspace_id, skill_id, gate_id, source,
        original_output, feedback_type, feedback_value, edited_output,
        delta, downstream_action, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING id`,
      [
        event.taskRunId ?? null,
        event.workspaceId,
        event.skillId ?? null,
        event.gateId ?? null,
        event.source,
        event.originalOutput ?? null,
        event.feedbackType,
        event.feedbackValue ?? null,
        event.editedOutput ?? null,
        delta ? JSON.stringify(delta) : null,
        event.downstreamAction ?? null,
      ]
    );

    const id = result.rows[0]?.id as string;
    logger.info(`Feedback event stored: ${id} [${event.source}/${event.feedbackType}] for ${event.skillId ?? "unknown"}`);
    return id;
  } catch (e) {
    logger.error(`Failed to store feedback event: ${(e as Error).message}`);
    return null;
  }
}
