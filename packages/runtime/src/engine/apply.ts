/**
 * Engine — applies TAG routing decisions.
 *
 * For each routed action, the engine performs the appropriate side effect:
 * - auto_execute: write output drawers, schedule next step via outbox
 * - approval_required: create waitpoint, notify via channel role
 * - escalate: write escalation drawer, notify ops
 * - flag: write flagged drawer, continue
 * - defer: schedule next step for later via outbox
 */

import type { PalaceSession } from "@nexaas/palace";
import { appendWal } from "@nexaas/palace/wal";
import { sql } from "@nexaas/palace/db";
import type { RoutedAction } from "../tag/route.js";
import { runTracker } from "../run-tracker.js";

export interface ApplyContext {
  session: PalaceSession;
  runId: string;
  stepId: string;
}

export async function apply(
  action: RoutedAction,
  ctx: ApplyContext,
): Promise<void> {
  const { session, runId, stepId } = ctx;
  const workspace = session.ctx.workspace;

  switch (action.routing) {
    case "auto_execute": {
      await session.writeDrawer(
        { wing: "events", hall: "skill", room: "executed" },
        JSON.stringify({
          action_kind: action.action.kind,
          payload: action.action.payload,
          source: action.source,
        }),
        {
          run_id: runId,
          step_id: stepId,
        },
      );

      await appendWal({
        workspace,
        op: "action_auto_executed",
        actor: `skill:${session.ctx.skillId}`,
        payload: {
          run_id: runId,
          step_id: stepId,
          action_kind: action.action.kind,
          source: action.source,
        },
      });
      break;
    }

    case "approval_required": {
      const signal = `approval:${runId}:${action.action.kind}:${Date.now()}`;
      const timeout = action.notify?.timeout ?? "7d";

      await session.createWaitpoint({
        signal,
        room: { wing: "events", hall: "skill", room: "pending-approval" },
        state: {
          action_kind: action.action.kind,
          payload: action.action.payload,
          source: action.source,
          notify: action.notify,
        },
        timeout,
        notify: action.notify,
      });

      await runTracker.markWaiting(runId);

      // Write to pending_approvals projection for the client dashboard
      await sql(
        `INSERT INTO pending_approvals
          (workspace_id, skill_id, action_type, summary, details, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', now() + $6::interval)
         ON CONFLICT DO NOTHING`,
        [
          workspace,
          session.ctx.skillId,
          action.action.kind,
          `Approval required: ${action.action.kind}`,
          JSON.stringify(action.action.payload),
          timeout,
        ],
      );

      await appendWal({
        workspace,
        op: "waitpoint_created",
        actor: `skill:${session.ctx.skillId}`,
        payload: {
          run_id: runId,
          step_id: stepId,
          signal,
          action_kind: action.action.kind,
          timeout,
          channel_role: action.notify?.channel_role,
        },
      });
      break;
    }

    case "escalate": {
      await session.writeDrawer(
        { wing: "ops", hall: "escalations", room: session.ctx.skillId ?? "unknown" },
        JSON.stringify({
          action_kind: action.action.kind,
          payload: action.action.payload,
          source: action.source,
          reason: action.reason ?? "TAG escalation",
        }),
        {
          run_id: runId,
          step_id: stepId,
        },
      );

      await runTracker.markEscalated(runId);

      // Write ops alert for the notification system
      await sql(
        `INSERT INTO nexaas_memory.ops_alerts
          (workspace, event_type, tier, severity, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          workspace,
          "tag_escalate",
          "inbox",
          "high",
          JSON.stringify({
            run_id: runId,
            skill_id: session.ctx.skillId,
            action_kind: action.action.kind,
            reason: action.reason ?? "TAG escalation",
          }),
        ],
      );

      await appendWal({
        workspace,
        op: "action_escalated",
        actor: `skill:${session.ctx.skillId}`,
        payload: {
          run_id: runId,
          step_id: stepId,
          action_kind: action.action.kind,
          source: action.source,
        },
      });
      break;
    }

    case "flag": {
      await session.writeDrawer(
        { wing: "events", hall: "skill", room: "flagged" },
        JSON.stringify({
          action_kind: action.action.kind,
          payload: action.action.payload,
          source: action.source,
          flagged: true,
        }),
        {
          run_id: runId,
          step_id: stepId,
        },
      );

      await appendWal({
        workspace,
        op: "action_flagged",
        actor: `skill:${session.ctx.skillId}`,
        payload: {
          run_id: runId,
          step_id: stepId,
          action_kind: action.action.kind,
        },
      });
      break;
    }

    case "defer": {
      const deferUntil = action.action.payload.defer_until as string | undefined;

      // Write intent to the outbox for the relay to pick up
      await sql(
        `INSERT INTO nexaas_memory.outbox
          (workspace, intent_type, payload)
         VALUES ($1, 'enqueue_delayed', $2)`,
        [
          workspace,
          JSON.stringify({
            run_id: runId,
            step_id: stepId,
            skill_id: session.ctx.skillId,
            defer_until: deferUntil ?? new Date(Date.now() + 3600000).toISOString(),
            action_kind: action.action.kind,
          }),
        ],
      );

      await appendWal({
        workspace,
        op: "action_deferred",
        actor: `skill:${session.ctx.skillId}`,
        payload: {
          run_id: runId,
          step_id: stepId,
          action_kind: action.action.kind,
          defer_until: deferUntil,
        },
      });
      break;
    }
  }
}
