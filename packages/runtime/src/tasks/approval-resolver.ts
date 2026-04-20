/**
 * Approval-callback resolver (companion to #39 inbound + #40 outbound + #45 Stage 1a TAG).
 *
 * Closes the last leg of the approval round-trip:
 *
 *   Skill produces approval_required output  → TAG (bb93498)
 *   Approval-request drawer → notifications.pending.waitpoints.<run_id>
 *   #40 outbound dispatcher  → channel adapter → human sees buttons
 *   Human taps button        → channel adapter → inbox.messaging.<role>
 *                                                drawer with action_button_click
 *   THIS task                → resolveWaitpoint(signal, decision, actor)
 *   Resolution drawer written → pillar-pipeline skill resumes (via outbox)
 *
 * Correlation: the inbox drawer carries `action_button_click.message_id`.
 * That message_id matches `notification_dispatches.channel_message_id`
 * for the dispatch that delivered the approval-request. The dispatch row
 * points at the source drawer (`drawer_id`), and that source drawer's
 * content carries the `waitpoint_signal`. Adapter doesn't have to encode
 * anything; framework does the lookup.
 *
 * Framework-integrity (project_three_roles): works identically for direct
 * adopter and operator-managed workspaces. No billing / plan / tier gating.
 * No channel-specific code — any adapter writing v0.2-shaped inbox drawers
 * with action_button_click + message_id is a valid producer.
 *
 * Scope of this pass:
 *   - Resolves waitpoints tied to approval-request drawers
 *   - Emits outbox entries for pillar-pipeline skill resumption
 *   - NO effect on ai-skill.ts-based skills (Phoenix's current path) —
 *     that's #45 Stage 1b's work
 *   - NO re-delivery of approval UIs on timeout — existing waitpoint-reaper
 *     handles that via NotifyConfig.on_timeout
 */

import { randomUUID } from "crypto";
import { sql, appendWal, resolveWaitpoint } from "@nexaas/palace";
import { findSkillManifest } from "../skill-manifest-index.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const POLL_BATCH_SIZE = 50;
const RESOLVER_MARKER_SKILL_ID = "(approval-resolver)";

interface InboundCallbackDrawer {
  id: string;
  content: string;
  created_at: string;
}

interface DispatchRow {
  drawer_id: string;
  channel_role: string;
}

interface ActionButtonClick {
  button_id: string;
  message_id: string;
}

let _polling = false;
let _interval: NodeJS.Timeout | null = null;

function extractClick(content: string): ActionButtonClick | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const click = parsed.action_button_click as Record<string, unknown> | undefined;
    if (!click || typeof click.button_id !== "string" || typeof click.message_id !== "string") {
      return null;
    }
    return { button_id: click.button_id, message_id: click.message_id };
  } catch { return null; }
}

async function selectPending(workspace: string): Promise<InboundCallbackDrawer[]> {
  // Candidate inbound drawers that haven't been processed by the resolver
  // yet. The `inbound_dispatches` sentinel row for skill_id = resolver
  // marker serves as the idempotency guard — same pattern used by the
  // inbound dispatcher for no-subscriber drawers.
  return await sql<InboundCallbackDrawer>(
    `SELECT e.id, e.content, e.created_at
       FROM nexaas_memory.events e
      WHERE e.workspace = $1
        AND e.wing = 'inbox'
        AND e.hall = 'messaging'
        AND e.dormant_signal IS NULL
        AND e.content::jsonb ? 'action_button_click'
        AND NOT EXISTS (
          SELECT 1 FROM nexaas_memory.inbound_dispatches d
           WHERE d.workspace = e.workspace
             AND d.drawer_id = e.id
             AND d.skill_id = $2
        )
      ORDER BY e.created_at ASC
      LIMIT $3`,
    [workspace, RESOLVER_MARKER_SKILL_ID, POLL_BATCH_SIZE],
  );
}

async function markProcessed(
  workspace: string,
  drawerId: string,
  runId: string | null,
  status: "resolved" | "ignored" | "failed",
  error?: string,
): Promise<void> {
  await sql(
    `INSERT INTO nexaas_memory.inbound_dispatches
        (workspace, drawer_id, skill_id, run_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace, drawer_id, skill_id) DO NOTHING`,
    [workspace, drawerId, RESOLVER_MARKER_SKILL_ID, runId, status, error ?? null],
  );
}

interface ApprovalRequestContent {
  kind?: string;
  waitpoint_signal?: string;
  run_id?: string;
  step_id?: string;
  skill_id?: string;                                 // original skill id (#53)
  output_id?: string;
  channel_role?: string;
  decisions?: Array<{ id: string; label?: string }>;
  handlers?: Record<string, string>;                 // decision → handler skill_id (#53)
  payload_full?: Record<string, unknown>;            // original output payload
}

async function lookupApprovalContext(
  workspace: string,
  channelMessageId: string,
): Promise<{
  dispatch: DispatchRow;
  approval: ApprovalRequestContent;
} | null> {
  const rows = await sql<{ drawer_id: string; channel_role: string; source_content: string }>(
    `SELECT d.drawer_id, d.channel_role, e.content AS source_content
       FROM nexaas_memory.notification_dispatches d
       JOIN nexaas_memory.events e ON e.id = d.drawer_id
      WHERE d.workspace = $1 AND d.channel_message_id = $2
      LIMIT 1`,
    [workspace, channelMessageId],
  );
  const row = rows[0];
  if (!row) return null;

  let approval: ApprovalRequestContent;
  try {
    approval = JSON.parse(row.source_content) as ApprovalRequestContent;
  } catch { return null; }

  // Only resolve drawers that were emitted by TAG as approval_request.
  // Skips plain-notification dispatches that happen to get a button click
  // (rare but possible for freeform interactive messages).
  if (approval.kind !== "approval_request" || typeof approval.waitpoint_signal !== "string") {
    return null;
  }

  return {
    dispatch: { drawer_id: row.drawer_id, channel_role: row.channel_role },
    approval,
  };
}

async function enqueueResumption(
  workspace: string,
  approval: ApprovalRequestContent,
  decision: string,
  actor: string,
): Promise<{ strategy: "handler" | "resume_original" | "none"; handler_skill?: string; error?: string }> {
  // #53 — if the approval block declared a handler skill for this decision,
  // enqueue a fresh run of that skill with the original-run context as
  // triggerPayload. Matches event-driven composition (architecture §9)
  // and works for both ai-skill.ts and pillar-pipeline origin skills.
  const handlerSkillId = approval.handlers?.[decision];
  if (handlerSkillId) {
    const handlerEntry = findSkillManifest(handlerSkillId);
    if (!handlerEntry) {
      return {
        strategy: "handler",
        handler_skill: handlerSkillId,
        error: `handler skill '${handlerSkillId}' not found in nexaas-skills tree`,
      };
    }
    const handlerRunId = randomUUID();
    await sql(
      `INSERT INTO nexaas_memory.outbox (workspace, intent_type, payload)
       VALUES ($1, 'enqueue_job', $2)`,
      [
        workspace,
        JSON.stringify({
          run_id: handlerRunId,
          skill_id: handlerEntry.skillId,
          step_id: handlerEntry.execType,
          manifest_path: handlerEntry.manifestPath,
          trigger_type: "resumption",
          trigger_payload: {
            decision,
            actor,
            resolved_at: new Date().toISOString(),
            original_run_id: approval.run_id,
            original_skill_id: approval.skill_id,
            original_output_id: approval.output_id,
            original_payload: approval.payload_full,
            channel_role: approval.channel_role,
          },
        }),
      ],
    );
    return { strategy: "handler", handler_skill: handlerSkillId };
  }

  // Legacy path — target the original run with resumedWith. Only meaningful
  // for pillar-pipeline skills (runSkillStep consumes resumedWith). ai-skill
  // origin runs are effectively no-op here; authors who need resumption
  // should declare handlers[decision] per #53.
  if (!approval.run_id || !approval.step_id) return { strategy: "none" };
  await sql(
    `INSERT INTO nexaas_memory.outbox (workspace, intent_type, payload)
     VALUES ($1, 'enqueue_job', $2)`,
    [
      workspace,
      JSON.stringify({
        run_id: approval.run_id,
        step_id: approval.step_id,
        trigger_type: "resumption",
        resumed_with: {
          decision,
          actor,
          output_id: approval.output_id,
          resolved_at: new Date().toISOString(),
        },
      }),
    ],
  );
  return { strategy: "resume_original" };
}

export async function resolvePendingApprovals(workspace: string): Promise<{
  resolved: number;
  ignored: number;
  errors: number;
}> {
  const pending = await selectPending(workspace);
  let resolved = 0, ignored = 0, errors = 0;

  for (const drawer of pending) {
    const click = extractClick(drawer.content);
    if (!click) {
      await markProcessed(workspace, drawer.id, null, "ignored", "malformed action_button_click");
      ignored++;
      continue;
    }

    const ctx = await lookupApprovalContext(workspace, click.message_id);
    if (!ctx) {
      // Not an approval callback — regular inbound message with buttons.
      await markProcessed(workspace, drawer.id, null, "ignored", "no matching approval dispatch");
      ignored++;
      continue;
    }

    // Validate decision is one the skill declared. If an adapter forges
    // a button_id outside the declared set, treat as ignored rather than
    // resolving with an unexpected decision.
    const decisionIds = (ctx.approval.decisions ?? []).map((d) => d.id);
    if (decisionIds.length > 0 && !decisionIds.includes(click.button_id)) {
      await markProcessed(workspace, drawer.id, null, "ignored", `decision '${click.button_id}' not in manifest-declared list`);
      await appendWal({
        workspace,
        op: "approval_decision_rejected",
        actor: "approval-resolver",
        payload: {
          drawer_id: drawer.id,
          message_id: click.message_id,
          attempted_decision: click.button_id,
          allowed_decisions: decisionIds,
        },
      });
      ignored++;
      continue;
    }

    try {
      // Resolve the waitpoint. Throws if already resolved or signal missing.
      const result = await resolveWaitpoint(
        ctx.approval.waitpoint_signal!,
        {
          decision: click.button_id,
          output_id: ctx.approval.output_id,
          resolved_via: "inbound-callback",
          inbox_drawer_id: drawer.id,
        },
        `approval-callback:${drawer.id}`,
      );

      // Fire resumption. If the approval declared a handler skill (#53),
      // enqueue that. Otherwise target the original run (legacy pillar-
      // pipeline resume). For ai-skill origin runs without a handler,
      // this is a no-op — the run already completed.
      const resumption = await enqueueResumption(
        workspace,
        ctx.approval,
        click.button_id,
        `approval-callback:${drawer.id}`,
      );

      await markProcessed(workspace, drawer.id, result.runId ?? null, "resolved");
      await appendWal({
        workspace,
        op: click.button_id === "approve" ? "approval_granted"
          : click.button_id === "reject" ? "approval_denied"
          : "approval_resolved",
        actor: "approval-resolver",
        payload: {
          drawer_id: drawer.id,
          run_id: result.runId,
          skill_id: result.skillId,
          step_id: result.stepId,
          signal: ctx.approval.waitpoint_signal,
          decision: click.button_id,
          channel_role: ctx.approval.channel_role,
          resumption_strategy: resumption.strategy,
          handler_skill: resumption.handler_skill,
          resumption_error: resumption.error,
        },
      });
      if (resumption.error) {
        // Handler was declared but the skill isn't installed. Surface
        // prominently — operator needs to add the handler skill or fix
        // the manifest.
        await appendWal({
          workspace,
          op: "approval_handler_missing",
          actor: "approval-resolver",
          payload: {
            drawer_id: drawer.id,
            decision: click.button_id,
            handler_skill: resumption.handler_skill,
            error: resumption.error,
          },
        });
      }
      resolved++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Waitpoint not found" = already resolved (double-click, race).
      // Treat as ignored-but-processed so we don't spin on it.
      if (msg.includes("Waitpoint not found")) {
        await markProcessed(workspace, drawer.id, null, "ignored", "waitpoint already resolved");
        ignored++;
        continue;
      }
      // Leave unmarked so the resolver retries on next poll.
      await appendWal({
        workspace,
        op: "approval_resolve_failed",
        actor: "approval-resolver",
        payload: {
          drawer_id: drawer.id,
          message_id: click.message_id,
          signal: ctx.approval.waitpoint_signal,
          error: msg.slice(0, 500),
        },
      });
      errors++;
    }
  }

  return { resolved, ignored, errors };
}

export function startApprovalResolver(
  workspace: string,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      const result = await resolvePendingApprovals(workspace);
      if (result.resolved > 0 || result.errors > 0) {
        console.log(
          `[nexaas] Approval resolver: ${result.resolved} resolved, ${result.ignored} ignored, ${result.errors} errors`,
        );
      }
    } catch (err) {
      console.error("[nexaas] approval resolver error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Approval resolver started (polling every ${interval / 1000}s)`);
}

export function stopApprovalResolver(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
