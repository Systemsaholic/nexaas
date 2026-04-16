/**
 * Sub-agent invocation — Layer 1 focused model calls.
 *
 * A skill step can delegate to specialist model invocations
 * with narrower prompts, tool subsets, palace scopes, and typed return shapes.
 */

import { palace } from "@nexaas/palace";
import { ModelGateway, type ModelTier } from "./models/gateway.js";
import type { Tool } from "./models/gateway.js";

export interface SubAgentConfig {
  id: string;
  purpose: string;
  systemPrompt: string;
  modelTier: ModelTier;
  tools?: Tool[];
  palaceScope?: {
    retrievalRooms: Array<{ wing: string; hall: string; room: string }>;
  };
  outputSchema?: Record<string, unknown>;
}

export interface SubAgentInput {
  workspace: string;
  runId: string;
  parentStepId: string;
  config: SubAgentConfig;
  input: Record<string, unknown>;
}

export async function subagent(params: SubAgentInput): Promise<Record<string, unknown>> {
  // TODO: Week 2 implementation
  // 1. Enter palace with narrowed scope (sub-agent's declared retrieval rooms only)
  // 2. Assemble context from the narrowed palace scope
  // 3. Call ModelGateway with the sub-agent's model tier + system prompt + tools
  // 4. Validate output against outputSchema if declared
  // 5. Record the sub-agent invocation as a drawer in the parent step's room
  // 6. Return the typed result to the parent step

  throw new Error("subagent() not yet implemented — Week 2");
}
