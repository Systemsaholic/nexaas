/**
 * TAG — Trigger-Action Gateway (Option C layered policy).
 *
 * Evaluates each proposed action against two layers:
 * 1. Skill manifest routing defaults
 * 2. Workspace behavioral contract overrides (within allowed envelopes)
 *
 * Every override (accepted or denied) is logged to the WAL.
 */

import { appendWal } from "@nexaas/palace/wal";
import type { ExecuteResult, ModelAction } from "../models/gateway.js";

export type RoutingDecision =
  | "auto_execute"
  | "approval_required"
  | "escalate"
  | "flag"
  | "defer";

export interface RoutedAction {
  action: ModelAction;
  routing: RoutingDecision;
  source: string;
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
}): Promise<TagRouting> {
  // TODO: Week 2 implementation
  // 1. Load skill manifest outputs[] with routing_default, overridable, overridable_to
  // 2. Load workspace behavioral contract skill_overrides
  // 3. For each action in output:
  //    a. Find manifest rule for action.kind
  //    b. If no rule, escalate (unknown action kind)
  //    c. If no contract override, use manifest default
  //    d. If contract override exists:
  //       - Check if manifest allows override (overridable: true)
  //       - Check if override target is in allowed envelope (overridable_to)
  //       - If allowed, apply override with authorization chain
  //       - If denied, log denial to WAL, keep manifest default
  // 4. Return routing decisions

  const actions: RoutedAction[] = params.output.actions.map((action) => ({
    action,
    routing: "auto_execute" as RoutingDecision,
    source: "stub-default",
  }));

  return { actions, skillId: params.skillId, workspace: params.workspace };
}
