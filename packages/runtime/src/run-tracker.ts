/**
 * runTracker — library-enforced skill_runs state transitions.
 *
 * Every drawer write in the pillar pipeline flows through this.
 * It owns the transactional envelope for drawer + skill_runs consistency.
 * Skill authors never touch skill_runs directly.
 */

import { sql } from "@nexaas/palace/db";

export type RunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "escalated"
  | "cancelled";

export const runTracker = {
  async createRun(params: {
    runId: string;
    workspace: string;
    skillId: string;
    skillVersion?: string;
    agentId?: string;
    triggerType: string;
    triggerPayload?: Record<string, unknown>;
    parentRunId?: string;
    depth?: number;
  }): Promise<void> {
    await sql(
      `INSERT INTO nexaas_memory.skill_runs
        (run_id, workspace, skill_id, skill_version, agent_id,
         trigger_type, trigger_payload, status, parent_run_id, depth)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9)`,
      [
        params.runId, params.workspace, params.skillId,
        params.skillVersion, params.agentId,
        params.triggerType, JSON.stringify(params.triggerPayload ?? {}),
        params.parentRunId, params.depth ?? 0,
      ],
    );
  },

  async markStepStarted(runId: string, stepId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET current_step = $2, last_activity = now(), status = 'running'
       WHERE run_id = $1`,
      [runId, stepId],
    );
  },

  async markStepCompleted(runId: string, stepId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET last_activity = now()
       WHERE run_id = $1`,
      [runId],
    );
  },

  async markStepFailed(runId: string, stepId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'failed', error_summary = $2, last_activity = now(), completed_at = now()
       WHERE run_id = $1`,
      [runId, message],
    );
  },

  async markWaiting(runId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'waiting', last_activity = now()
       WHERE run_id = $1`,
      [runId],
    );
  },

  async markCompleted(runId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'completed', last_activity = now(), completed_at = now()
       WHERE run_id = $1`,
      [runId],
    );
  },

  async markEscalated(runId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'escalated', last_activity = now()
       WHERE run_id = $1`,
      [runId],
    );
  },

  async markCancelled(runId: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'cancelled', last_activity = now(), completed_at = now()
       WHERE run_id = $1`,
      [runId],
    );
  },

  async updateTokenUsage(
    runId: string,
    usage: { input: number; output: number; cost_usd: number },
  ): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET token_usage = COALESCE(token_usage, '{}')::jsonb || $2::jsonb,
           last_activity = now()
       WHERE run_id = $1`,
      [
        runId,
        JSON.stringify({
          input_tokens: usage.input,
          output_tokens: usage.output,
          cost_usd: usage.cost_usd,
        }),
      ],
    );
  },
};
