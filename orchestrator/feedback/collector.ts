/**
 * Feedback signal collector.
 *
 * Captures skill improvement signals and execution failures,
 * writes them to the local skill_feedback Postgres table.
 * Runs on client VPSes.
 */

import { query } from "../db.js";

export type FeedbackSignal =
  | "skill_improvement"
  | "execution_failure"
  | "escalation"
  | "user_feedback";

export interface FeedbackEvent {
  skillId: string;
  workspaceId: string;
  sessionId?: string;
  signal: FeedbackSignal;
  evidence?: Record<string, unknown>;
  claudeReflection?: string;
  proposedImprovement?: string;
}

export async function captureFeedback(event: FeedbackEvent): Promise<number> {
  const result = await query(
    `INSERT INTO skill_feedback
      (skill_id, workspace_id, session_id, signal, evidence, claude_reflection, proposed_improvement)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      event.skillId,
      event.workspaceId,
      event.sessionId ?? null,
      event.signal,
      event.evidence ? JSON.stringify(event.evidence) : null,
      event.claudeReflection ?? null,
      event.proposedImprovement ?? null,
    ]
  );
  return result.rows[0].id as number;
}

export async function captureSkillImprovement(params: {
  skillId: string;
  workspaceId: string;
  content: string;
  runId?: string;
}): Promise<number> {
  const marker = "SKILL_IMPROVEMENT_CANDIDATE:";
  const idx = params.content.indexOf(marker);
  const reflection = idx >= 0
    ? params.content.slice(idx + marker.length).trim()
    : params.content;

  return captureFeedback({
    skillId: params.skillId,
    workspaceId: params.workspaceId,
    signal: "skill_improvement",
    evidence: { rawOutput: params.content.slice(0, 2000), runId: params.runId },
    claudeReflection: reflection,
  });
}

export async function captureFailure(params: {
  skillId?: string;
  workspaceId: string;
  taskId: string;
  error: string;
  selfHealAttempt?: string;
  runId: string;
}): Promise<number> {
  return captureFeedback({
    skillId: params.skillId ?? "unknown",
    workspaceId: params.workspaceId,
    signal: "execution_failure",
    evidence: {
      taskId: params.taskId,
      error: params.error.slice(0, 2000),
      selfHealAttempt: params.selfHealAttempt,
      runId: params.runId,
    },
  });
}

export async function getUncollectedFeedback(): Promise<Array<Record<string, unknown>>> {
  const result = await query(
    `SELECT * FROM skill_feedback WHERE collected = false ORDER BY created_at ASC LIMIT 100`
  );
  return result.rows;
}

export async function markCollected(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE skill_feedback SET collected = true WHERE id = ANY($1)`,
    [ids]
  );
}
