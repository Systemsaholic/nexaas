/**
 * ModelGateway — provider-agnostic model execution with tier-based selection.
 *
 * Skills declare what tier they need (cheap/good/better/best).
 * The gateway resolves the tier to a concrete provider + model via the registry,
 * applies workspace policies, and handles fallback chains on failure.
 */

import { appendWal } from "@nexaas/palace/wal";

export type ModelTier = "cheap" | "good" | "better" | "best";

export interface ExecuteParams {
  tier: ModelTier;
  messages: Message[];
  system?: string;
  tools?: Tool[];
  retrieval?: RetrievalChunk[];
  workspaceId: string;
  runId: string;
  stepId: string;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RetrievalChunk {
  content: string;
  source: string;
  relevance: number;
}

export interface ExecuteResult {
  content: string;
  actions: ModelAction[];
  tokenUsage: { input: number; output: number; cost_usd: number };
  provider: string;
  model: string;
  isFallback: boolean;
}

export interface ModelAction {
  kind: string;
  payload: Record<string, unknown>;
}

export const ModelGateway = {
  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    // TODO: Week 2 implementation
    // 1. Load model registry
    // 2. Resolve tier to primary + fallbacks
    // 3. Apply workspace contract policies (provider caps, tier caps, cost caps)
    // 4. Check context window fit
    // 5. Pre-check workspace cost cap
    // 6. Try primary with 3-retry exponential backoff (100ms, 400ms, 1s)
    // 7. On retryable failure, walk fallback chain
    // 8. Normalize tool-use format across providers
    // 9. Record token usage + cost
    // 10. If best-tier fell back to non-Claude, auto-elevate routing
    // 11. Log to WAL
    // 12. Return normalized result

    throw new Error("ModelGateway.execute not yet implemented — Week 2");
  },
};
