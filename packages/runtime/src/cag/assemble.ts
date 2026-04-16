/**
 * CAG — Context-Augmented Generation.
 *
 * Assembles the full context a skill step needs by walking the palace:
 * - Behavioral contract (tone, approval posture, escalation rules)
 * - Live workspace state (integration snapshots, active resources)
 * - Workflow execution state (prior drawers in this run, decisions made)
 * - Retrieval room contents (declared in skill manifest)
 */

import type { PalaceSession } from "@nexaas/palace";
import type { ModelTier, Message, Tool } from "../models/gateway.js";

export interface AssembleParams {
  session: PalaceSession;
  stepId: string;
  resumedWith?: Record<string, unknown>;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  modelTier: ModelTier;
  retrievalRooms: Array<{ wing: string; hall: string; room: string }>;
}

export async function assemble(params: AssembleParams): Promise<AssembledContext> {
  // TODO: Week 2 implementation
  // 1. Load skill manifest for the current run's skill_id + skill_version
  // 2. Extract: model_tier for this step, retrieval_rooms, prompt path
  // 3. Load behavioral contract from workspace manifest
  // 4. Walk palace rooms declared in retrieval_rooms:
  //    a. For each room: load closets first (compacted drawers)
  //    b. Load live-tail drawers newer than compaction watermark
  //    c. Record staleness telemetry
  // 5. If resumedWith is present, include the resolution context
  // 6. Assemble the system prompt from: skill prompt.md + behavioral contract tone + schema extensions
  // 7. Build the messages array from assembled context
  // 8. Resolve tools from capability bindings in the workspace manifest
  // 9. Return assembled context for the model gateway

  return {
    systemPrompt: "TODO: assemble from skill prompt + contract",
    messages: [],
    tools: [],
    modelTier: "good",
    retrievalRooms: [],
  };
}
