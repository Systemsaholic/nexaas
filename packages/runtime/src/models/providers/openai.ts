/**
 * OpenAI provider — GPT model invocation via openai SDK.
 * Also handles openai-compatible endpoints (self-hosted models via vLLM, TGI, etc.)
 */

import OpenAI from "openai";
import type { ModelEntry } from "../registry.js";
import type { Message, Tool, ModelAction } from "../gateway.js";

const _clients = new Map<string, OpenAI>();

function getClient(baseURL?: string, apiKey?: string): OpenAI {
  const key = baseURL ?? "default";
  if (!_clients.has(key)) {
    _clients.set(
      key,
      new OpenAI({
        apiKey: apiKey ?? process.env.OPENAI_API_KEY,
        ...(baseURL ? { baseURL } : {}),
      }),
    );
  }
  return _clients.get(key)!;
}

export interface OpenAIResult {
  content: string;
  actions: ModelAction[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

function toOpenAIMessages(
  messages: Message[],
  system?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const m of messages) {
    if (m.role === "system") continue;
    result.push({
      role: m.role as "user" | "assistant",
      content: m.content,
    });
  }

  return result;
}

function toOpenAITools(
  tools: Tool[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function extractActions(
  response: OpenAI.ChatCompletion,
): { text: string; actions: ModelAction[] } {
  const choice = response.choices[0];
  if (!choice) return { text: "", actions: [] };

  const text = choice.message.content ?? "";
  const actions: ModelAction[] = [];

  if (choice.message.tool_calls) {
    for (const call of choice.message.tool_calls) {
      if (call.type === "function") {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(call.function.arguments);
        } catch {
          payload = { raw: call.function.arguments };
        }
        actions.push({
          kind: call.function.name,
          payload,
        });
      }
    }
  }

  return { text, actions };
}

export async function invoke(
  model: ModelEntry,
  messages: Message[],
  system?: string,
  tools?: Tool[],
  baseURL?: string,
  apiKey?: string,
): Promise<OpenAIResult> {
  const client = getClient(baseURL, apiKey);

  const params: OpenAI.ChatCompletionCreateParams = {
    model: model.model,
    messages: toOpenAIMessages(messages, system),
  };

  if (tools && tools.length > 0) {
    params.tools = toOpenAITools(tools);
  }

  const response = await client.chat.completions.create(params);

  const { text, actions } = extractActions(response);

  return {
    content: text,
    actions,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    stopReason: response.choices[0]?.finish_reason ?? "stop",
  };
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return true;
    if (error.status === 500) return true;
    if (error.status === 502) return true;
    if (error.status === 503) return true;
  }
  if (error instanceof Error && error.message.includes("ECONNRESET")) return true;
  if (error instanceof Error && error.message.includes("ETIMEDOUT")) return true;
  return false;
}
