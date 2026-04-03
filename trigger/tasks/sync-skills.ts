/**
 * Skill sync task — orchestrates the full promotion flow.
 *
 * Called by check-approvals when a proposal is approved.
 * Runs: propagator -> version-router -> rsync -> git commit.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { propagateSkill, commitSkillUpdate } from "../../orchestrator/sync/propagator.js";
import { notifyTelegram } from "../lib/telegram.js";
import { query } from "../../orchestrator/db.js";

export const syncSkills = task({
  id: "sync-skills",
  queue: { name: "skill-sync", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async (payload: { proposalId: number; skillId: string; version: string }) => {
    logger.info(`Syncing skill: ${payload.skillId} v${payload.version}`);

    const result = await propagateSkill(payload.skillId, payload.version);

    if (result.synced.length > 0) {
      await commitSkillUpdate(payload.skillId, payload.version);
    }

    await query(
      `UPDATE skill_proposals SET status = 'deployed' WHERE id = $1`,
      [payload.proposalId]
    );

    await notifyTelegram({
      user: "al",
      type: "briefing",
      title: `Synced: ${payload.skillId} v${payload.version}`,
      body: `Deployed to: ${result.synced.join(", ") || "none"}\nSkipped: ${result.skipped.join(", ") || "none"}\nFailed: ${result.failed.map((f) => f.workspaceId).join(", ") || "none"}`,
    });

    return result;
  },
});
