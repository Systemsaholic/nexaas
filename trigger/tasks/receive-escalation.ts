/**
 * Receives failure escalations from client VPSes.
 *
 * Stores the escalation in the core's skill_feedback table,
 * then checks for correlation: has this skill/task failed on
 * other workspaces recently?
 *
 * If correlated (2+ workspaces): triggers diagnose-failure.
 * If isolated (1 workspace): Telegram alert.
 */

import { task, logger, tasks } from "@trigger.dev/sdk/v3";
import { query } from "../../orchestrator/db.js";
import { notifyTelegram } from "../lib/telegram.js";
import { z } from "zod";

const EscalationSchema = z.object({
  workspaceId: z.string(),
  skillId: z.string().optional(),
  taskId: z.string(),
  error: z.string(),
  selfHealAttempt: z.string().optional(),
  runId: z.string(),
  timestamp: z.string(),
});

export const receiveEscalation = task({
  id: "receive-escalation",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 60,
  run: async (payload: unknown) => {
    const parsed = EscalationSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error("Invalid escalation payload", { errors: parsed.error.issues });
      return { success: false, error: "invalid payload" };
    }

    const esc = parsed.data;
    logger.info(`Escalation from ${esc.workspaceId}: ${esc.taskId}`, {
      error: esc.error.slice(0, 200),
    });

    // Store in core DB
    await query(
      `INSERT INTO skill_feedback
        (skill_id, workspace_id, signal, evidence, created_at)
       VALUES ($1, $2, 'escalation', $3, NOW())`,
      [
        esc.skillId || esc.taskId,
        esc.workspaceId,
        JSON.stringify({
          taskId: esc.taskId,
          error: esc.error,
          selfHealAttempt: esc.selfHealAttempt,
          runId: esc.runId,
        }),
      ]
    );

    // Check correlation: same skill/task failed on other workspaces in last 24h
    const correlationKey = esc.skillId || esc.taskId;
    const correlated = await query(
      `SELECT DISTINCT workspace_id FROM skill_feedback
       WHERE skill_id = $1
         AND signal IN ('escalation', 'execution_failure')
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [correlationKey]
    );

    const affectedWorkspaces = correlated.rows.map((r) => r.workspace_id as string);

    if (affectedWorkspaces.length >= 2) {
      logger.info(`Correlated failure: ${correlationKey} on ${affectedWorkspaces.length} workspaces`);
      await tasks.trigger("diagnose-failure", {
        skillId: correlationKey,
        workspaces: affectedWorkspaces,
        latestError: esc.error,
      });
      return { success: true, action: "diagnosis-triggered", workspaces: affectedWorkspaces };
    }

    // Isolated failure — alert via Telegram
    await notifyTelegram({
      user: "al",
      type: "alert",
      title: `Failure: ${esc.taskId}`,
      body: `Workspace: ${esc.workspaceId}\nError: ${esc.error.slice(0, 300)}${esc.selfHealAttempt ? `\nSelf-heal: ${esc.selfHealAttempt}` : ""}`,
      priority: "urgent",
    });

    return { success: true, action: "alert-sent" };
  },
});
