/**
 * Dashboard Channel Adapter — delivers via the Nexmatic client portal.
 *
 * Writes to pending_approvals (for two-way) or activity_log (for one-way).
 * The client sees it in their dashboard.
 */

import { query } from "../../db.js";
import { logger } from "@trigger.dev/sdk/v3";

export interface DashboardDeliveryPayload {
  workspaceId: string;
  skillId?: string;
  type: "approval" | "notification" | "alert";
  summary: string;
  details: Record<string, unknown>;
  waitTokenId?: string;  // for approval requests
}

export async function deliverViaDashboard(payload: DashboardDeliveryPayload): Promise<boolean> {
  try {
    if (payload.type === "approval" && payload.waitTokenId) {
      // Two-way: write to pending_approvals
      await query(
        `INSERT INTO pending_approvals
         (workspace_id, skill_id, action_type, summary, details, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '7 days', NOW())`,
        [
          payload.workspaceId,
          payload.skillId ?? "unknown",
          payload.type,
          payload.summary,
          JSON.stringify({ ...payload.details, waitTokenId: payload.waitTokenId }),
        ]
      );
    } else {
      // One-way: write to activity_log
      await query(
        `INSERT INTO activity_log
         (workspace_id, skill_id, action, summary, details, tag_route, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          payload.workspaceId,
          payload.skillId ?? "unknown",
          payload.type,
          payload.summary,
          JSON.stringify(payload.details),
          payload.type === "alert" ? "flag" : "notify_after",
        ]
      );
    }

    logger.info(`Dashboard delivery: ${payload.type} for ${payload.workspaceId}`);
    return true;
  } catch (e) {
    logger.error(`Dashboard delivery failed: ${(e as Error).message}`);
    return false;
  }
}
