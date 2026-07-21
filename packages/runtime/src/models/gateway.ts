/**
 * ModelGateway — provider-agnostic model execution with tier-based selection.
 *
 * Skills declare what tier they need (cheap/good/better/best).
 * The gateway resolves the tier to a concrete provider + model via the registry,
 * applies workspace policies, and handles fallback chains on failure.
 */

import {
  loadRegistry,
  resolveTier,
  getProviderConfig,
  estimateCost,
  type ModelEntry,
  type ModelRegistry,
} from "./registry.js";
import * as anthropicProvider from "./providers/anthropic.js";
import * as openaiProvider from "./providers/openai.js";
import { appendWal } from "@nexaas/palace";
import { assertWithinBudget, recordSpend } from "./spend-governor.js";
import {
  runAgenticLoop,
  type AgenticLimits,
  type AgenticModelChoice,
  type AgenticResult,
  type McpTool,
  type ToolExecutor,
} from "./agentic-loop.js";
import type Anthropic from "@anthropic-ai/sdk";

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
  tokenUsage: {
    input: number;
    output: number;
    cache_creation?: number;
    cache_read?: number;
    cost_usd: number;
  };
  provider: string;
  model: string;
  isFallback: boolean;
}

export interface ModelAction {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Resolve a tier to the model chain the AGENTIC path can walk (#255).
 *
 * The agentic loop speaks the Anthropic Messages API natively (streaming,
 * tool_use blocks, cache_control) — non-Anthropic registry fallbacks are
 * filtered out because switching wire formats mid-conversation would
 * require a full tool-loop translation layer. Cross-provider fallback
 * remains available on the single-shot execute() path below. Registry
 * invariant guarded by tests: every tier's PRIMARY is Anthropic, so this
 * never returns an empty chain for a declared tier.
 */
export function resolveAgenticChain(
  tier: string,
  registry?: ModelRegistry,
): AgenticModelChoice[] {
  const { primary, fallbacks } = resolveTier(tier, registry);
  return [primary, ...fallbacks]
    .filter((e) => e.provider === "anthropic")
    .map((e) => ({
      model: e.model,
      pricing:
        e.input_cost_per_m != null && e.output_cost_per_m != null
          ? { inputCostPerM: e.input_cost_per_m, outputCostPerM: e.output_cost_per_m }
          : undefined,
    }));
}

export interface ExecuteAgenticParams {
  /** Manifest/persona model_tier — resolution happens HERE, not at call sites. */
  tier: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: McpTool[];
  executeTool: ToolExecutor;
  workspace: string;
  runId: string;
  skillId: string;
  limits?: AgenticLimits;
}

const RETRY_DELAYS = [100, 400, 1000];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface InvokeOutcome {
  content: string;
  actions: ModelAction[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

async function invokeModel(
  entry: ModelEntry,
  messages: Message[],
  system?: string,
  tools?: Tool[],
): Promise<InvokeOutcome> {
  const registry = loadRegistry();
  const providerConfig = getProviderConfig(entry.provider, registry);

  if (entry.provider === "anthropic") {
    const result = await anthropicProvider.invoke(entry, messages, system, tools);
    return {
      content: result.content,
      actions: result.actions,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      cacheReadTokens: result.cacheReadTokens,
    };
  }

  // OpenAI and openai-compatible providers
  const baseURL =
    providerConfig.kind === "openai-compatible" && providerConfig.base_url_env
      ? process.env[providerConfig.base_url_env]
      : undefined;

  const apiKey = process.env[providerConfig.auth_env];

  const result = await openaiProvider.invoke(
    entry,
    messages,
    system,
    tools,
    baseURL,
    apiKey,
  );

  return {
    content: result.content,
    actions: result.actions,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function isRetryable(provider: string, error: unknown): boolean {
  if (provider === "anthropic") return anthropicProvider.isRetryable(error);
  return openaiProvider.isRetryable(error);
}

async function tryWithRetries(
  entry: ModelEntry,
  messages: Message[],
  system?: string,
  tools?: Tool[],
): Promise<InvokeOutcome | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await invokeModel(entry, messages, system, tools);
    } catch (err) {
      if (!isRetryable(entry.provider, err)) return null;
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt]!);
      }
    }
  }
  return null;
}

export const ModelGateway = {
  /**
   * The live execution path (#255): every agentic caller (ai-skill, PA
   * service, subagent) routes model runs through here.
   * Gains over the previous direct-SDK call sites, all in one place:
   *   - registry-driven model selection (no hardcoded TIER_MAPs anywhere)
   *   - pre-call daily budget gate (#215) — SpendBudgetExceededError is a
   *     policy stop, never "recovered" by a still-billable fallback
   *   - same-API model fallback chain, walked per-turn inside the loop
   *   - registry pricing for real spend-cap enforcement + accounting
   * WAL (per-turn) + recordSpend stay inside runAgenticLoop — the loop is
   * the accounting chokepoint; this wrapper is the policy + resolution one.
   */
  async executeAgentic(params: ExecuteAgenticParams): Promise<AgenticResult> {
    await assertWithinBudget(params.workspace);

    const chain = resolveAgenticChain(params.tier);
    if (chain.length === 0) {
      throw new Error(
        `No Anthropic-capable model in registry for tier '${params.tier}' — the agentic path requires one`,
      );
    }

    return runAgenticLoop({
      model: chain[0]!.model,
      modelPricing: chain[0]!.pricing,
      fallbackModels: chain.slice(1),
      system: params.system,
      messages: params.messages,
      tools: params.tools,
      executeTool: params.executeTool,
      workspace: params.workspace,
      runId: params.runId,
      skillId: params.skillId,
      limits: params.limits,
    });
  },

  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    const { tier, messages, system, tools, workspaceId, runId, stepId } = params;

    // Daily budget gate (#215) — evaluated BEFORE resolving providers so a
    // breach can never enter tryWithRetries or the fallback chain below.
    // SpendBudgetExceededError propagates to the caller as-is; it is a
    // policy stop, not a provider failure, and must never be "recovered"
    // by falling back to another (still billable) provider.
    await assertWithinBudget(workspaceId);

    const { primary, fallbacks } = resolveTier(tier);

    // Build the full message list including retrieval context
    const fullMessages = [...messages];
    if (params.retrieval && params.retrieval.length > 0) {
      const retrievalContext = params.retrieval
        .map((r) => `[Retrieved from ${r.source}, relevance: ${r.relevance.toFixed(2)}]\n${r.content}`)
        .join("\n\n---\n\n");

      fullMessages.unshift({
        role: "user",
        content: `Relevant context retrieved from memory:\n\n${retrievalContext}`,
      });
    }

    // Try primary with retries
    const primaryResult = await tryWithRetries(primary, fullMessages, system, tools);

    if (primaryResult) {
      const cost = estimateCost(
        primary,
        primaryResult.inputTokens,
        primaryResult.outputTokens,
        primaryResult.cacheCreationTokens,
        primaryResult.cacheReadTokens,
      );

      await appendWal({
        workspace: workspaceId,
        op: "model_call",
        actor: `skill:${params.stepId}`,
        payload: {
          tier,
          provider: primary.provider,
          model: primary.model,
          input_tokens: primaryResult.inputTokens,
          output_tokens: primaryResult.outputTokens,
          cache_creation_input_tokens: primaryResult.cacheCreationTokens,
          cache_read_input_tokens: primaryResult.cacheReadTokens,
          cost_usd: cost,
          fallback: false,
          run_id: runId,
          step_id: stepId,
        },
      });

      await recordSpend(workspaceId, cost);

      return {
        content: primaryResult.content,
        actions: primaryResult.actions,
        tokenUsage: {
          input: primaryResult.inputTokens,
          output: primaryResult.outputTokens,
          cache_creation: primaryResult.cacheCreationTokens,
          cache_read: primaryResult.cacheReadTokens,
          cost_usd: cost,
        },
        provider: primary.provider,
        model: primary.model,
        isFallback: false,
      };
    }

    // Primary failed after retries — walk fallback chain
    for (const fallback of fallbacks) {
      const fallbackResult = await tryWithRetries(fallback, fullMessages, system, tools);

      if (fallbackResult) {
        const cost = estimateCost(
          fallback,
          fallbackResult.inputTokens,
          fallbackResult.outputTokens,
          fallbackResult.cacheCreationTokens,
          fallbackResult.cacheReadTokens,
        );

        await appendWal({
          workspace: workspaceId,
          op: "model_fallback",
          actor: `skill:${params.stepId}`,
          payload: {
            tier,
            primary_provider: primary.provider,
            primary_model: primary.model,
            fallback_provider: fallback.provider,
            fallback_model: fallback.model,
            input_tokens: fallbackResult.inputTokens,
            output_tokens: fallbackResult.outputTokens,
            cache_creation_input_tokens: fallbackResult.cacheCreationTokens,
            cache_read_input_tokens: fallbackResult.cacheReadTokens,
            cost_usd: cost,
            run_id: runId,
            step_id: stepId,
          },
        });

        await recordSpend(workspaceId, cost);

        return {
          content: fallbackResult.content,
          actions: fallbackResult.actions,
          tokenUsage: {
            input: fallbackResult.inputTokens,
            output: fallbackResult.outputTokens,
            cache_creation: fallbackResult.cacheCreationTokens,
            cache_read: fallbackResult.cacheReadTokens,
            cost_usd: cost,
          },
          provider: fallback.provider,
          model: fallback.model,
          isFallback: true,
        };
      }
    }

    // All providers failed
    await appendWal({
      workspace: workspaceId,
      op: "model_all_providers_failed",
      actor: `skill:${params.stepId}`,
      payload: {
        tier,
        primary: `${primary.provider}/${primary.model}`,
        fallbacks_tried: fallbacks.map((f) => `${f.provider}/${f.model}`),
        run_id: runId,
        step_id: stepId,
      },
    });

    throw new Error(
      `All model providers failed for tier '${tier}'. Primary: ${primary.provider}/${primary.model}. ` +
      `Fallbacks tried: ${fallbacks.map((f) => `${f.provider}/${f.model}`).join(", ")}`,
    );
  },
};
