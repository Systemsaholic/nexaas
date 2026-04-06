/**
 * HEARTBEAT — proactive department task.
 *
 * Architecture Guide v4 §12
 *
 * The agent wakes up, loads identity + context + memory,
 * checks what needs attention, and acts — or stays silent
 * if nothing does.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { executeSkill } from "../lib/skill-executor.js";
import { readFileSync } from "fs";
import { join } from "path";
import { query, queryOne } from "../../orchestrator/db.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export const heartbeatTask = task({
  id: "heartbeat",
  queue: { name: "heartbeat", concurrencyLimit: 2 },
  maxDuration: 300,
  run: async (payload: {
    workspaceId: string;
    department: string;
    scheduleKey: string;
    silenceCondition?: string;
  }) => {
    const { workspaceId, department, scheduleKey, silenceCondition } = payload;
    logger.info(`HEARTBEAT: ${workspaceId}/${department}/${scheduleKey}`);

    // Load previous session memory
    const memories = await query(
      `SELECT key, value FROM agent_memory
       WHERE workspace_id = $1 AND department = $2
       ORDER BY updated_at DESC`,
      [workspaceId, department]
    );

    const openItems = memories.rows
      .filter((r: any) => r.key === "open_items")
      .map((r: any) => r.value)?.[0] ?? [];

    const lastSummary = memories.rows
      .find((r: any) => r.key === "last_session_summary");

    // Build memory context for Claude
    const memoryContext = {
      openItems: Array.isArray(openItems) ? openItems : [],
      lastSessionSummary: lastSummary?.value?.summary ?? "No previous session.",
      previousRunDate: lastSummary?.value?.date ?? "Never",
    };

    // Get the HEARTBEAT schedule description
    const schedule = await queryOne<{ cron: string; silence_condition: string | null }>(
      `SELECT cron, silence_condition FROM heartbeat_schedules
       WHERE workspace_id = $1 AND department = $2 AND schedule_key = $3`,
      [workspaceId, department, scheduleKey]
    );

    // Execute as a skill-like task — loads identity docs, CAG context
    const result = await executeSkill({
      skillId: `heartbeat/${department}`,
      workspaceId,
      input: {
        department,
        scheduleKey,
        task: `Run the ${scheduleKey} HEARTBEAT for the ${department} department.`,
        memory: memoryContext,
        silenceCondition: silenceCondition ?? schedule?.silence_condition ?? null,
        instructions: `You are running a proactive ${department} check (${scheduleKey}).
Load the ${department} operations guidelines. Check what needs attention.
If the silence condition "${silenceCondition ?? "none"}" is met, respond with {"silent": true, "reason": "..."}.
Otherwise, produce a briefing/report/alert.
Update open items: close resolved ones, add new ones.
Include a session summary for next time.`,
      },
    });

    // Update agent memory
    if (result.parsed) {
      // Update open items
      if (result.parsed.openItems) {
        await query(
          `INSERT INTO agent_memory (workspace_id, department, memory_type, key, value, updated_at)
           VALUES ($1, $2, 'open_items', 'open_items', $3, NOW())
           ON CONFLICT (workspace_id, department, memory_type, key)
           DO UPDATE SET value = $3, updated_at = NOW()`,
          [workspaceId, department, JSON.stringify(result.parsed.openItems)]
        );
      }

      // Update session summary
      await query(
        `INSERT INTO agent_memory (workspace_id, department, memory_type, key, value, updated_at)
         VALUES ($1, $2, 'session_summary', 'last_session_summary', $3, NOW())
         ON CONFLICT (workspace_id, department, memory_type, key)
         DO UPDATE SET value = $3, updated_at = NOW()`,
        [workspaceId, department, JSON.stringify({
          summary: result.parsed.sessionSummary ?? result.parsed.summary ?? "Completed",
          date: new Date().toISOString(),
          scheduleKey,
        })]
      );
    }

    // Update last_run in heartbeat_schedules
    await query(
      `UPDATE heartbeat_schedules SET last_run = NOW()
       WHERE workspace_id = $1 AND department = $2 AND schedule_key = $3`,
      [workspaceId, department, scheduleKey]
    );

    return result;
  },
});
