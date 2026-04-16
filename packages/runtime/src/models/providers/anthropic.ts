/**
 * Anthropic provider — Claude model invocation via @anthropic-ai/sdk.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelEntry } from "../registry.js";
import type { Message, Tool, ModelAction } from "../gateway.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _client;
}

export interface AnthropicResult {
  content: string;
  actions: ModelAction[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

function toAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

function toAnthropicTools(
  tools: Tool[],
): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
}

function extractActions(
  response: Anthropic.Message,
): { text: string; actions: ModelAction[] } {
  let text = "";
  const actions: ModelAction[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      actions.push({
        kind: block.name,
        payload: block.input as Record<string, unknown>,
      });
    }
  }

  return { text, actions };
}

export async function invoke(
  model: ModelEntry,
  messages: Message[],
  system?: string,
  tools?: Tool[],
): Promise<AnthropicResult> {
  const client = getClient();

  const params: Anthropic.MessageCreateParams = {
    model: model.model,
    max_tokens: 4096,
    messages: toAnthropicMessages(messages),
  };

  if (system) {
    params.system = system;
  }

  if (tools && tools.length > 0) {
    params.tools = toAnthropicTools(tools);
  }

  const response = await client.messages.create(params);

  const { text, actions } = extractActions(response);

  return {
    content: text,
    actions,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    stopReason: response.stop_reason ?? "end_turn",
  };
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) return true;
    if (error.status === 500) return true;
    if (error.status === 502) return true;
    if (error.status === 503) return true;
    if (error.status === 529) return true; // overloaded
  }
  if (error instanceof Error && error.message.includes("ECONNRESET")) return true;
  if (error instanceof Error && error.message.includes("ETIMEDOUT")) return true;
  return false;
}
