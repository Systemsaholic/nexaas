/**
 * TAG — Trigger-Action Gateway (Option C layered policy).
 *
 * Evaluates each proposed action against two layers:
 * 1. Skill manifest routing defaults
 * 2. Workspace behavioral contract overrides (within allowed envelopes)
 *
 * Every override (accepted or denied) is logged to the WAL.
 */

import { appendWal } from "@nexaas/palace";
import type { ExecuteResult, ModelAction } from "../models/gateway.js";

export type RoutingDecision =
  | "auto_execute"
  | "approval_required"
  | "escalate"
  | "flag"
  | "defer";

/**
 * Output kind classification per #45 spec — TAG evaluates routing based
 * on the kind, not the output id. Framework-canonical set; workspaces
 * can add custom kinds via schema_extensions (architecture.md §14).
 */
export type OutputKind =
  | "notification"          // channel send: Telegram, email, Slack
  | "external_send"         // email to customer, third-party API, payment
  | "palace_write"          // drawer write (committing a decision)
  | "subagent_invocation"   // spawning a sub-agent run
  | "mcp_tool_call"         // arbitrary MCP tool dispatch
  | (string & {});           // allow custom kinds without narrowing

export interface ManifestNotifyConfig {
  channel_role: string;
  timeout?: string;
  on_timeout?: string;
  reminder_before?: string;
  reminder_channel?: string;
  keywords?: Record<string, string[]>;
}

/**
 * Approval sub-block per #45 spec. When `routing_default: approval_required`,
 * this block declares who approves (channel_role), what decisions the
 * approver sees (buttons/keyword list), and how to handle no-response.
 */
export interface ManifestApproval {
  channel_role: string;                              // may contain {persona_id} template — resolved at route time
  decisions?: string[];                              // default: ["approve", "reject"]
  timeout_seconds?: number;                          // default 3600 (1h)
  on_timeout?: "deny" | "approve" | "escalate";      // default "deny"
  /**
   * Per-decision handler skill (#53). When a decision fires, instead of
   * re-entering the original skill run (which ai-skill.ts can't do
   * cleanly), the framework enqueues a fresh run of the named handler
   * skill with the decision + original-run context in triggerPayload.
   *
   * Example:
   *   handlers:
   *     approve: email/actually-send
   *     reject:  email/log-cancellation
   *     edit:    email/open-editor
   *
   * Omitting a key means no handler fires for that decision —
   * the resolution is recorded in the WAL and that's it. Skills
   * can still subscribe to `events.*` drawers for legacy composition.
   */
  handlers?: Record<string, string>;
}

export interface ManifestOutput {
  id: string;
  kind?: OutputKind;                                 // classification per #45; missing = framework infers from action
  routing_default: RoutingDecision;
  approval?: ManifestApproval;
  overridable?: boolean;
  overridable_to?: RoutingDecision[];
  notify?: ManifestNotifyConfig;                     // legacy field; prefer `approval.channel_role` for approval flows
  conditions?: Array<{                               // reserved for future stages; evaluator stub
    if: string;
    route?: RoutingDecision;
    escalate_to?: string;
    reason?: string;
  }>;
  flag?: { room: string };                           // for routing_default: flag
}

export interface ContractOverride {
  skill: string;
  output: string;
  routing: RoutingDecision;
  authorized_by: string;
  authorized_at: string;
  reason: string;
}

export interface SkillManifest {
  id: string;
  version: string;
  outputs: ManifestOutput[];
}

export interface BehavioralContract {
  skill_overrides?: ContractOverride[];
}

export interface RoutedAction {
  action: ModelAction;
  routing: RoutingDecision;
  source: string;
  notify?: ManifestNotifyConfig;
  /** From ManifestOutput.approval — used by engine.apply for approval_required. */
  approval?: ManifestApproval;
  /** Declared output kind from ManifestOutput.kind (notification, external_send, …). */
  output_kind?: OutputKind;
  authorized_by?: string;
  authorized_at?: string;
  reason?: string;
  override_denied?: Record<string, unknown>;
}

export interface TagRouting {
  actions: RoutedAction[];
  skillId: string;
  workspace: string;
}

export async function route(params: {
  output: ExecuteResult;
  skillId: string;
  workspace: string;
  manifest?: SkillManifest;
  contract?: BehavioralContract;
}): Promise<TagRouting> {
  const { output, skillId, workspace } = params;

  // Load manifest and contract — in production these come from the workspace
  // For now, accept them as params; the pipeline will pass them in
  const manifest = params.manifest ?? { id: skillId, version: "0.0.0", outputs: [] };
  const contract = params.contract ?? {};

  // If best-tier fell back to non-Claude, auto-elevate to approval_required
  const bestTierFallback = output.isFallback && output.provider !== "anthropic";

  const actions: RoutedAction[] = [];

  for (const action of output.actions) {
    const manifestRule = manifest.outputs.find((o) => o.id === action.kind);

    if (!manifestRule) {
      // Unknown action kind — always escalate
      actions.push({
        action,
        routing: "escalate",
        source: "tag-unknown-action",
      });

      await appendWal({
        workspace,
        op: "tag_unknown_action",
        actor: "tag",
        payload: { skill: skillId, action_kind: action.kind },
      });
      continue;
    }

    // Start with the manifest default
    let effectiveRouting = manifestRule.routing_default;
    let source = "manifest-default";
    let authorizedBy: string | undefined;
    let authorizedAt: string | undefined;
    let reason: string | undefined;
    let overrideDenied: Record<string, unknown> | undefined;

    // Check for contract override
    const override = contract.skill_overrides?.find(
      (o) => o.skill === skillId && o.output === action.kind,
    );

    if (override) {
      if (!manifestRule.overridable) {
        // Manifest-locked — override denied
        overrideDenied = {
          attempted: override.routing,
          by: override.authorized_by,
          reason: override.reason,
        };
        source = "manifest-locked";

        await appendWal({
          workspace,
          op: "tag_override_denied",
          actor: "tag",
          payload: {
            skill: skillId,
            output: action.kind,
            attempted: override.routing,
            reason: "manifest-locked",
          },
        });
      } else if (
        manifestRule.overridable_to &&
        !manifestRule.overridable_to.includes(override.routing)
      ) {
        // Override target outside allowed envelope
        overrideDenied = {
          attempted: override.routing,
          allowed: manifestRule.overridable_to,
          by: override.authorized_by,
        };
        source = "override-out-of-envelope";

        await appendWal({
          workspace,
          op: "tag_override_denied",
          actor: "tag",
          payload: {
            skill: skillId,
            output: action.kind,
            attempted: override.routing,
            allowed_envelope: manifestRule.overridable_to,
            reason: "out-of-envelope",
          },
        });
      } else {
        // Override accepted
        effectiveRouting = override.routing;
        source = "contract-override";
        authorizedBy = override.authorized_by;
        authorizedAt = override.authorized_at;
        reason = override.reason;

        await appendWal({
          workspace,
          op: "tag_override_accepted",
          actor: "tag",
          payload: {
            skill: skillId,
            output: action.kind,
            from: manifestRule.routing_default,
            to: override.routing,
            authorized_by: override.authorized_by,
            reason: override.reason,
          },
        });
      }
    }

    // Best-tier non-Claude fallback: auto-elevate to approval_required
    if (bestTierFallback && effectiveRouting === "auto_execute") {
      effectiveRouting = "approval_required";
      source = "best-tier-fallback-elevation";

      await appendWal({
        workspace,
        op: "tag_fallback_elevation",
        actor: "tag",
        payload: {
          skill: skillId,
          output: action.kind,
          original_routing: manifestRule.routing_default,
          elevated_to: "approval_required",
          reason: `Best-tier model fell back to non-Claude provider (${output.provider}/${output.model})`,
        },
      });
    }

    actions.push({
      action,
      routing: effectiveRouting,
      source,
      notify: manifestRule.notify,
      approval: (manifestRule as ManifestOutput).approval,  // forward for engine
      output_kind: manifestRule.kind,                       // #58 — kind-aware routing
      authorized_by: authorizedBy,
      authorized_at: authorizedAt,
      reason,
      override_denied: overrideDenied,
    });

    // Per #45 spec — every routing decision gets a canonical WAL entry.
    // Sits alongside the more specific ops (tag_override_accepted, etc.)
    // so operators can query "everything TAG decided on this skill" with
    // a single op filter.
    await appendWal({
      workspace,
      op: "tag_routed",
      actor: "tag",
      payload: {
        skill: skillId,
        output: action.kind,
        output_kind: manifestRule.kind,
        routing: effectiveRouting,
        source,
        override_denied: !!overrideDenied,
        authorized_by: authorizedBy,
      },
    });
  }

  return { actions, skillId, workspace };
}
