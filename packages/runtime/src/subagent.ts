/**
 * Sub-agent invocation — Layer 1 focused model calls.
 *
 * A skill step can delegate to specialist Claude invocations
 * with narrower prompts, tool subsets, palace scopes, and typed returns.
 * Keeps main-skill context windows manageable.
 */

import { palace, appendWal } from "@nexaas/palace";
import { runAgenticLoop, type McpTool } from "./models/agentic-loop.js";
import { McpClient, loadMcpConfigs } from "./mcp/client.js";
import type { ModelTier } from "./models/gateway.js";
import { randomUUID } from "crypto";

const TIER_MAP: Record<string, string> = {
  cheap: "claude-haiku-4-5-20251001",
  good: "claude-sonnet-4-6",
  better: "claude-sonnet-4-6",
  best: "claude-opus-4-6",
};

export interface SubAgentConfig {
  id: string;
  purpose: string;
  systemPrompt: string;
  modelTier: ModelTier;
  mcpServers?: string[];
  palaceScope?: {
    retrievalRooms: Array<{ wing: string; hall: string; room: string }>;
  };
}

export async function subagent(params: {
  workspace: string;
  parentRunId: string;
  parentStepId: string;
  config: SubAgentConfig;
  input: string;
}): Promise<{ content: string; toolCalls: number; turns: number }> {
  const { workspace, parentRunId, parentStepId, config, input } = params;
  const subRunId = randomUUID();
  const model = TIER_MAP[config.modelTier] ?? "claude-sonnet-4-6";

  // Connect to MCP servers if declared
  const mcpClients: McpClient[] = [];
  const allTools: McpTool[] = [];

  if (config.mcpServers) {
    const workspacePath = process.env.NEXAAS_WORKSPACE_ROOT ?? process.env.HOME ?? "/home/ubuntu";
    const mcpConfigs = loadMcpConfigs(workspacePath);

    for (const serverName of config.mcpServers) {
      const serverConfig = mcpConfigs[serverName];
      if (!serverConfig) continue;

      const client = new McpClient(serverName, serverConfig);
      try {
        await client.connect();
        mcpClients.push(client);
        for (const tool of client.getTools()) {
          allTools.push({
            name: `${serverName}__${tool.name}`,
            description: `[${serverName}] ${tool.description}`,
            input_schema: tool.input_schema,
          });
        }
      } catch { /* skip unavailable MCPs */ }
    }
  }

  const executeTool = async (toolName: string, toolInput: Record<string, unknown>): Promise<string> => {
    const parts = toolName.split("__");
    if (parts.length < 2) throw new Error(`Invalid tool name: ${toolName}`);
    const serverName = parts[0]!;
    const actualName = parts.slice(1).join("__");
    const client = mcpClients.find((c) => c["serverName"] === serverName);
    if (!client) throw new Error(`MCP not connected: ${serverName}`);
    return await client.callTool(actualName, toolInput);
  };

  // Gather context from narrowed palace scope
  let contextText = "";
  if (config.palaceScope?.retrievalRooms) {
    const session = palace.enter({ workspace, runId: parentRunId, skillId: config.id });
    for (const room of config.palaceScope.retrievalRooms) {
      const drawers = await session.walkRoom(room, { limit: 10 });
      if (drawers.length > 0) {
        contextText += `[Context from ${room.wing}/${room.hall}/${room.room}]:\n`;
        contextText += drawers.map((d) => d.content).join("\n---\n") + "\n\n";
      }
    }
  }

  const userMessage = contextText
    ? `${contextText}\n\nTask: ${input}`
    : input;

  try {
    const result = await runAgenticLoop({
      model,
      system: config.systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: allTools,
      executeTool,
      maxTurns: 10,
      workspace,
      runId: subRunId,
      skillId: `subagent:${config.id}`,
    });

    await appendWal({
      workspace,
      op: "subagent_completed",
      actor: `subagent:${config.id}`,
      payload: {
        parent_run_id: parentRunId,
        parent_step_id: parentStepId,
        sub_run_id: subRunId,
        turns: result.turns,
        tool_calls: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cache_creation_input_tokens: result.cacheCreationTokens,
        cache_read_input_tokens: result.cacheReadTokens,
      },
    });

    return {
      content: result.content,
      toolCalls: result.toolCalls.length,
      turns: result.turns,
    };
  } finally {
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
