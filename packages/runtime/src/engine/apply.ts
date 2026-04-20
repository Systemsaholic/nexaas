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
import { appendWal } from "@nexaas/palace";
import { sql } from "@nexaas/palace";
import type { RoutedAction } from "../tag/route.js";
import { runTracker } from "../run-tracker.js";
import type { WorkspaceManifest } from "../schemas/workspace-manifest.js";

export interface ApplyContext {
  session: PalaceSession;
  runId: string;
  stepId: string;
  // Workspace manifest from #41 — used to resolve channel_role templates
  // against channel_bindings. Optional because the pillar pipeline may
  // invoke apply() before the manifest is loaded; the engine then falls
  // back to the raw channel_role string.
  workspaceManifest?: WorkspaceManifest | null;
}

/**
 * Resolve a channel_role template against the workspace manifest.
 * Templates use `{var}` substitution. Returns the resolved role plus the
 * binding entry (kind/mcp/config) if one exists in the manifest.
 * Missing bindings return `{ role, binding: undefined }` — the caller
 * decides how strict to be.
 */
function resolveChannelBinding(
  roleTemplate: string,
  ctx: ApplyContext,
  templateVars: Record<string, string> = {},
): { role: string; binding?: { kind: string; mcp: string; config: Record<string, unknown> } } {
  const role = roleTemplate.replace(/\{(\w+)\}/g, (_, v) => templateVars[v] ?? `{${v}}`);
  const binding = ctx.workspaceManifest?.channel_bindings?.[role];
  return binding ? { role, binding } : { role };
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

      // Resolve channel_role → workspace binding if the manifest is loaded.
      // Template variables (e.g., {persona_id}) not yet wired in Stage 1a;
      // future stages populate them from skill + run context.
      const approvalRoleRaw = action.approval?.channel_role ?? action.notify?.channel_role;
      const resolved = approvalRoleRaw
        ? resolveChannelBinding(approvalRoleRaw, ctx)
        : undefined;

      // Waitpoint drawer — dormant until approval callback resolves it.
      await session.createWaitpoint({
        signal,
        room: { wing: "events", hall: "skill", room: "pending-approval" },
        state: {
          action_kind: action.action.kind,
          payload: action.action.payload,
          source: action.source,
          notify: action.notify,
          channel_role: resolved?.role,
        },
        timeout,
      });

      await runTracker.markWaiting(runId);

      // Approval-request drawer to notifications.pending.waitpoints.<run_id>
      // per #45 spec. The outbound subscriber (#40) reads these and
      // dispatches via the bound channel. Adapter writes a callback that
      // calls palace.resolveWaitpoint(signal, ...) when the approver acts.
      if (resolved) {
        const decisions = action.approval?.decisions ?? ["approve", "reject"];
        const onTimeout = action.approval?.on_timeout ?? "deny";
        const payloadJson = JSON.stringify(action.action.payload ?? {});
        const payloadPreview = payloadJson.length > 500 ? payloadJson.slice(0, 500) + "…" : payloadJson;

        await session.writeDrawer(
          { wing: "notifications", hall: "pending", room: `waitpoints.${runId}` },
          JSON.stringify({
            kind: "approval_request",
            run_id: runId,
            step_id: stepId,
            waitpoint_signal: signal,
            output_id: action.action.kind,
            summary: `Approval required: ${action.action.kind}`,
            payload_preview: payloadPreview,
            decisions: decisions.map((id) => ({ id, label: id })),
            channel_role: resolved.role,
            channel_kind: resolved.binding?.kind,
            channel_mcp: resolved.binding?.mcp,
            channel_config: resolved.binding?.config,
            on_timeout: onTimeout,
            idempotency_key: `approval:${signal}`,
          }),
          {
            run_id: runId,
            step_id: stepId,
          },
        );

        await appendWal({
          workspace,
          op: "approval_requested",
          actor: `skill:${session.ctx.skillId}`,
          payload: {
            run_id: runId,
            step_id: stepId,
            output: action.action.kind,
            channel_role: resolved.role,
            channel_kind: resolved.binding?.kind,
            binding_resolved: !!resolved.binding,
            signal,
            decisions,
            on_timeout: onTimeout,
          },
        });
      }

      // Write to pending_approvals projection for the client dashboard
      // (legacy path — still consumed by Nexmatic client-dashboard).
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
          channel_role: resolved?.role ?? action.notify?.channel_role,
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
