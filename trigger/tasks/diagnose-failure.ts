/**
 * Diagnoses correlated failures across workspaces.
 *
 * When the same skill fails on 2+ workspaces, Claude Sonnet analyzes
 * the failure patterns and proposes a fix. If fixable, creates a
 * skill_proposal. If not, sends a Telegram alert with diagnosis.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../../orchestrator/db.js";
import { runClaude } from "../lib/claude.js";
import { notifyTelegram } from "../lib/telegram.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export const diagnoseFailure = task({
  id: "diagnose-failure",
  queue: { name: "orchestrator", concurrencyLimit: 2 },
  maxDuration: 300,
  run: async (payload: {
    skillId: string;
    workspaces: string[];
    latestError: string;
  }) => {
    logger.info(`Diagnosing correlated failure: ${payload.skillId}`, {
      workspaces: payload.workspaces,
    });

    // Gather all failure records for this skill
    const failures = await query(
      `SELECT workspace_id, evidence, created_at FROM skill_feedback
       WHERE skill_id = $1
         AND signal IN ('escalation', 'execution_failure')
         AND created_at > NOW() - INTERVAL '48 hours'
       ORDER BY created_at DESC LIMIT 20`,
      [payload.skillId]
    );

    // Try to read the skill's prompt.md if it exists
    let skillPrompt = "";
    try {
      const promptPath = join(NEXAAS_ROOT, "skills", ...payload.skillId.split("/"), "prompt.md");
      skillPrompt = readFileSync(promptPath, "utf-8").slice(0, 3000);
    } catch {
      skillPrompt = "(skill prompt not found on core)";
    }

    // Build failure summary for Claude
    const failureSummary = failures.rows.map((r) => {
      const ev = typeof r.evidence === "string" ? JSON.parse(r.evidence as string) : r.evidence;
      return `- Workspace: ${r.workspace_id}, Error: ${(ev as any)?.error?.slice(0, 200) || "unknown"}, Time: ${r.created_at}`;
    }).join("\n");

    const result = await runClaude({
      prompt: `You are diagnosing a skill failure that occurred across ${payload.workspaces.length} workspaces.

Skill ID: ${payload.skillId}

Skill prompt (current version):
---
${skillPrompt}
---

Failure records:
${failureSummary}

Latest error: ${payload.latestError}

Analyze the root cause. Is this:
1. A skill bug (fixable by changing the prompt or config)?
2. An infrastructure issue (auth, network, disk)?
3. An external dependency issue (API down, rate limited)?

If it's a skill bug (#1), respond with:
FIX: [description of the change needed to prompt.md or skill.yaml]

If it's infrastructure or external (#2 or #3), respond with:
MANUAL: [description of what needs to be done and on which workspaces]

Keep response under 300 words.`,
      model: "sonnet",
      timeoutMs: 120_000,
      mcpServers: [],
    });

    if (!result.success) {
      logger.error(`Diagnosis failed: ${result.error}`);
      await notifyTelegram({
        user: "al",
        type: "alert",
        title: `Diagnosis Failed: ${payload.skillId}`,
        body: `Could not diagnose failure on ${payload.workspaces.join(", ")}.\nError: ${result.error}`,
        priority: "urgent",
      });
      return { success: false, error: result.error };
    }

    const isFix = result.output.toUpperCase().startsWith("FIX:");

    if (isFix) {
      const fixDescription = result.output.slice(4).trim();
      await query(
        `INSERT INTO skill_proposals
          (skill_id, workspace_id, from_version, proposed_version,
           proposed_improvement, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
        [
          payload.skillId,
          payload.workspaces[0],
          "current",
          "patch",
          fixDescription,
        ]
      );

      logger.info(`Created fix proposal for ${payload.skillId}`);

      await notifyTelegram({
        user: "al",
        type: "approval",
        title: `Fix Proposed: ${payload.skillId}`,
        body: `Failed on: ${payload.workspaces.join(", ")}\n\nProposed fix:\n${fixDescription.slice(0, 300)}`,
        buttons: [
          { text: "Approve", callback_data: `approve_skill:${payload.skillId}` },
          { text: "Reject", callback_data: `reject_skill:${payload.skillId}` },
        ],
        skipDedup: true,
      });

      return { success: true, action: "proposal-created", fix: fixDescription };
    }

    // Manual intervention needed
    await notifyTelegram({
      user: "al",
      type: "alert",
      title: `Manual Fix Needed: ${payload.skillId}`,
      body: `Workspaces: ${payload.workspaces.join(", ")}\n\n${result.output.slice(0, 500)}`,
      priority: "urgent",
    });

    return { success: true, action: "manual-alert", diagnosis: result.output };
  },
});
