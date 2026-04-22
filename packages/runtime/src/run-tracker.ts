/**
 * runTracker — library-enforced skill_runs state transitions.
 *
 * Every drawer write in the pillar pipeline flows through this.
 * It owns the transactional envelope for drawer + skill_runs consistency.
 * Skill authors never touch skill_runs directly.
 */

import { sql } from "@nexaas/palace";
import { getFrameworkIdentity } from "./fleet/heartbeat.js";
import { checkFailureStreak } from "./tasks/silent-failure-watchdog.js";

export type RunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "escalated"
  | "cancelled"
  | "skipped";

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
    // Stamp the framework version that produced this run. Best-effort —
    // older installs without migration 015 will error on the extra column,
    // in which case we fall back to the legacy insert shape.
    const identity = (() => {
      try { return getFrameworkIdentity(); } catch { return null; }
    })();
    try {
      await sql(
        `INSERT INTO nexaas_memory.skill_runs
          (run_id, workspace, skill_id, skill_version, agent_id,
           trigger_type, trigger_payload, status, parent_run_id, depth, framework_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10)`,
        [
          params.runId, params.workspace, params.skillId,
          params.skillVersion, params.agentId,
          params.triggerType, JSON.stringify(params.triggerPayload ?? {}),
          params.parentRunId, params.depth ?? 0,
          identity?.version ?? null,
        ],
      );
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      // 42703 = undefined_column — pre-migration-015 schema. Retry without it.
      if (pgErr.code === "42703") {
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
        return;
      }
      throw err;
    }
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
    const rows = await sql<{ workspace: string; skill_id: string }>(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'failed', error_summary = $2, last_activity = now(), completed_at = now()
       WHERE run_id = $1
       RETURNING workspace, skill_id`,
      [runId, message],
    );
    // Silent-failure watchdog (#69). Best-effort — never block the failure
    // path on the watchdog or let it override the original error surface.
    const row = rows[0];
    if (row) {
      try {
        await checkFailureStreak(row.workspace, row.skill_id);
      } catch (err) {
        console.error("[nexaas] silent-failure watchdog error:", err);
      }
    }
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

  async markSkipped(runId: string, reason: string): Promise<void> {
    await sql(
      `UPDATE nexaas_memory.skill_runs
       SET status = 'skipped',
           error_summary = $2,
           last_activity = now(),
           completed_at = now()
       WHERE run_id = $1`,
      [runId, reason],
    );
  },

  async updateTokenUsage(
    runId: string,
    usage: {
      input: number;
      output: number;
      cache_creation?: number;
      cache_read?: number;
      cost_usd: number;
    },
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
          cache_creation_input_tokens: usage.cache_creation ?? 0,
          cache_read_input_tokens: usage.cache_read ?? 0,
          cost_usd: usage.cost_usd,
        }),
      ],
    );
  },
};
