/**
 * Agentic loop — multi-turn tool-use execution with Claude.
 *
 * For skills that need Claude to call MCP tools iteratively:
 * 1. Send messages + tools to Claude
 * 2. Claude responds with tool_use blocks
 * 3. Execute each tool call against the MCP server
 * 4. Send results back as tool_result messages
 * 5. Repeat until Claude stops calling tools
 *
 * This is the core of real Nexaas AI skill execution.
 */

import Anthropic from "@anthropic-ai/sdk";
import { appendWal } from "@nexaas/palace";
import type { ModelAction } from "./gateway.js";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export interface McpTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolExecutor {
  (toolName: string, input: Record<string, unknown>): Promise<string>;
}

export interface AgenticResult {
  content: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  actions: ModelAction[];
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export async function runAgenticLoop(params: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: McpTool[];
  executeTool: ToolExecutor;
  maxTurns?: number;
  workspace: string;
  runId: string;
  skillId: string;
}): Promise<AgenticResult> {
  const { model, system, tools, executeTool, maxTurns = 20, workspace, runId, skillId } = params;
  const client = getClient();

  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));

  let messages = [...params.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;
  const allToolCalls: AgenticResult["toolCalls"] = [];
  let finalContent = "";

  while (turns < maxTurns) {
    turns++;

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages,
      tools: anthropicTools,
    });

    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    // Collect text content
    let turnText = "";
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        turnText += block.text;
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    finalContent = turnText;

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
      // Log final turn
      await appendWal({
        workspace,
        op: "agentic_turn",
        actor: `skill:${skillId}`,
        payload: {
          run_id: runId,
          turn: turns,
          tool_calls: 0,
          stop_reason: response.stop_reason,
          final: true,
        },
      });
      break;
    }

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;

      let result: string;
      try {
        result = await executeTool(toolUse.name, input);
        allToolCalls.push({ name: toolUse.name, input, result: result.slice(0, 500) });
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        allToolCalls.push({ name: toolUse.name, input, result });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // Log this turn
    await appendWal({
      workspace,
      op: "agentic_turn",
      actor: `skill:${skillId}`,
      payload: {
        run_id: runId,
        turn: turns,
        tool_calls: toolUseBlocks.map((t) => t.name),
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });

    // Add assistant response + tool results to conversation
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  return {
    content: finalContent,
    toolCalls: allToolCalls,
    actions: [],
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    turns,
  };
}
