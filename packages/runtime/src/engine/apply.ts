/**
 * Engine — applies TAG routing decisions.
 *
 * For each routed action, the engine performs the appropriate side effect:
 * - auto_execute: write output drawers, fire MCP calls, schedule next step
 * - approval_required: create waitpoint, notify via channel role
 * - escalate: write escalation drawer, notify ops
 * - flag: write flagged drawer, continue
 * - defer: schedule next step for later
 */

import type { PalaceSession } from "@nexaas/palace";
import type { RoutedAction } from "../tag/route.js";

export interface ApplyContext {
  session: PalaceSession;
  runId: string;
  stepId: string;
}

export async function apply(
  action: RoutedAction,
  ctx: ApplyContext,
): Promise<void> {
  // TODO: Week 2 implementation
  switch (action.routing) {
    case "auto_execute":
      // Write output drawer to the appropriate room
      // If the action involves MCP calls, execute them
      // If there's a next step, enqueue it via the outbox
      break;

    case "approval_required":
      // Create a waitpoint (dormant drawer with signal)
      // Notify via the channel role declared in the skill manifest
      // Run suspends — no next step enqueued until waitpoint resolves
      break;

    case "escalate":
      // Write escalation drawer to ops.escalations.*
      // Notify ops via ops_page or ops_inbox channel
      // Run may continue or suspend depending on escalation severity
      break;

    case "flag":
      // Write drawer with flagged=true metadata
      // Continue to next step normally
      break;

    case "defer":
      // Schedule next step for the specified defer_until time
      // Enqueue a delayed job via the outbox
      break;
  }
}
