/**
 * Polls for approved skill proposals and triggers sync.
 * Runs every 5 minutes on the core.
 * Also expires stale proposals (>7 days pending).
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { query } from "../../orchestrator/db.js";
import { expireStaleProposals } from "../../orchestrator/promotion/human-gate.js";
import { syncSkills } from "./sync-skills.js";

export const checkApprovals = task({
  id: "check-approvals",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 120,
  run: async () => {
    const expired = await expireStaleProposals();
    if (expired > 0) {
      logger.info(`Expired ${expired} stale proposals`);
    }

    const approved = await query(
      `SELECT id, skill_id, proposed_version FROM skill_proposals
       WHERE status = 'approved'
       ORDER BY reviewed_at ASC LIMIT 5`
    );

    if (approved.rows.length === 0) {
      return { checked: true, deployments: 0 };
    }

    logger.info(`Found ${approved.rows.length} approved proposals to deploy`);

    for (const proposal of approved.rows) {
      await syncSkills.triggerAndWait({
        proposalId: proposal.id as number,
        skillId: proposal.skill_id as string,
        version: proposal.proposed_version as string,
      });
    }

    return { checked: true, deployments: approved.rows.length };
  },
});

export const checkApprovalsSchedule = schedules.task({
  id: "check-approvals-schedule",
  cron: "*/5 * * * *",
  maxDuration: 30,
  run: async () => {
    await checkApprovals.trigger();
  },
});
