/**
 * Human approval gate for skill proposals.
 *
 * Sends a Telegram notification with Approve/Reject buttons.
 * The Telegram bot callback writes approval to the DB.
 * A polling task picks up approved proposals and triggers sync.
 */

import { query, queryOne } from "../db.js";
import { notifyTelegram } from "../../trigger/lib/telegram.js";
import { checkCompatibility } from "./dependency-checker.js";

export async function sendApprovalRequest(proposalId: number): Promise<boolean> {
  const proposal = await queryOne(
    `SELECT * FROM skill_proposals WHERE id = $1`,
    [proposalId]
  );

  if (!proposal) return false;

  const skillId = proposal.skill_id as string;
  const fromVersion = proposal.from_version as string;
  const proposedVersion = proposal.proposed_version as string;
  const improvement = proposal.proposed_improvement as string;
  const workspaceId = proposal.workspace_id as string;

  const compat = await checkCompatibility(skillId, proposedVersion);

  const compatText = compat.compatible.length > 0
    ? `Deploy to: ${compat.compatible.map((c) => c.name).join(", ")}`
    : "No compatible workspaces";

  const skipText = compat.incompatible.length > 0
    ? `\nSkip: ${compat.incompatible.map((c) => `${c.name} (${c.missing.join(", ")})`).join(", ")}`
    : "";

  await notifyTelegram({
    user: "al",
    type: "approval",
    title: `Skill Proposal: ${skillId} ${fromVersion} -> ${proposedVersion}`,
    body: `Source: ${workspaceId}\n\n${improvement.slice(0, 400)}\n\n${compatText}${skipText}`,
    buttons: [
      { text: "Approve", callback_data: `approve_proposal:${proposalId}` },
      { text: "Reject", callback_data: `reject_proposal:${proposalId}` },
    ],
    skipDedup: true,
  });

  return true;
}

export async function approveProposal(proposalId: number, reviewedBy: string): Promise<void> {
  await query(
    `UPDATE skill_proposals SET status = 'approved', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [proposalId, reviewedBy]
  );
}

export async function rejectProposal(proposalId: number, reviewedBy: string): Promise<void> {
  await query(
    `UPDATE skill_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW() WHERE id = $1`,
    [proposalId, reviewedBy]
  );
}

export async function expireStaleProposals(): Promise<number> {
  const result = await query(
    `UPDATE skill_proposals SET status = 'expired'
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '7 days'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}
