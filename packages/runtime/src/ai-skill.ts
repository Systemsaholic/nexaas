/**
 * AI Skill executor — runs a skill through the Nexaas pillar pipeline.
 *
 * For skills with `execution.type: ai-skill` in their manifest.
 * This is the REAL Nexaas execution path:
 *   1. Load skill manifest + prompt
 *   2. Connect to declared MCP servers
 *   3. Assemble context from the palace (CAG)
 *   4. Run the agentic loop (Claude + MCP tools, multi-turn)
 *   5. Record all actions and results as palace drawers
 *   6. Log everything to the WAL
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { palace, appendWal } from "@nexaas/palace";
import { runTracker } from "./run-tracker.js";
import { McpClient, loadMcpConfigs } from "./mcp/client.js";
import { runAgenticLoop, type McpTool } from "./models/agentic-loop.js";
import { resolveTier, estimateCost, type ModelEntry } from "./models/registry.js";

export interface AiSkillManifest {
  id: string;
  version: string;
  description?: string;
  execution: {
    type: "ai-skill";
    model_tier?: string;
  };
  mcp_servers?: string[];
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
    retrieval_rooms?: Array<{ wing: string; hall: string; room: string }>;
  };
  outputs?: Array<{
    id: string;
    routing_default: string;
  }>;
  self_reflection?: boolean;
}

const TIER_MAP: Record<string, string> = {
  cheap: "claude-haiku-4-5-20251001",
  good: "claude-sonnet-4-6",
  better: "claude-sonnet-4-6",
  best: "claude-opus-4-6",
};

export async function runAiSkill(
  workspace: string,
  manifest: AiSkillManifest,
  manifestPath: string,
): Promise<{ success: boolean; turns: number; toolCalls: number; content: string }> {
  const runId = randomUUID();
  const stepId = "ai-exec";

  await runTracker.createRun({
    runId,
    workspace,
    skillId: manifest.id,
    skillVersion: manifest.version,
    triggerType: "cron",
  });

  await runTracker.markStepStarted(runId, stepId);

  const session = palace.enter({ workspace, runId, skillId: manifest.id, stepId });

  // Load the prompt
  const skillDir = dirname(manifestPath);
  const promptPath = join(skillDir, "prompt.md");
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(promptPath, "utf-8");
  } catch {
    systemPrompt = manifest.description ?? `Execute skill: ${manifest.id}`;
  }

  // Resolve the model
  const tier = manifest.execution.model_tier ?? "good";
  const model = TIER_MAP[tier] ?? "claude-sonnet-4-6";

  // Connect to MCP servers
  // Look for .mcp.json in these locations (in order):
  // 1. NEXAAS_WORKSPACE_ROOT env var
  // 2. Walk up from manifest path until we find .mcp.json
  // 3. Home directory
  let workspacePath = process.env.NEXAAS_WORKSPACE_ROOT ?? "";
  if (!workspacePath) {
    let searchPath = dirname(manifestPath);
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(searchPath, ".mcp.json"))) {
        workspacePath = searchPath;
        break;
      }
      const parent = dirname(searchPath);
      if (parent === searchPath) break;
      searchPath = parent;
    }
  }
  if (!workspacePath) workspacePath = process.env.HOME ?? "/home/ubuntu";
  const mcpConfigs = loadMcpConfigs(workspacePath);
  const mcpClients: McpClient[] = [];
  const allTools: McpTool[] = [];

  if (manifest.mcp_servers) {
    for (const serverName of manifest.mcp_servers) {
      const config = mcpConfigs[serverName];
      if (!config) {
        console.warn(`[nexaas] MCP server '${serverName}' not found in .mcp.json — skipping`);
        continue;
      }

      const client = new McpClient(serverName, config);
      try {
        await client.connect();
        mcpClients.push(client);
        const tools = client.getTools();
        // Prefix tool names with server name to avoid collisions
        for (const tool of tools) {
          allTools.push({
            name: `${serverName}__${tool.name}`,
            description: `[${serverName}] ${tool.description}`,
            input_schema: tool.input_schema,
          });
        }
        console.log(`[nexaas] Connected to MCP '${serverName}' (${tools.length} tools)`);
      } catch (err) {
        console.error(`[nexaas] Failed to connect to MCP '${serverName}':`, err);
      }
    }
  }

  // Tool executor that routes calls to the right MCP client
  const executeTool = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    const parts = toolName.split("__");
    if (parts.length < 2) throw new Error(`Invalid tool name: ${toolName}`);

    const serverName = parts[0]!;
    const actualToolName = parts.slice(1).join("__");
    const client = mcpClients.find((c) => c["serverName"] === serverName);

    if (!client) throw new Error(`MCP server not connected: ${serverName}`);

    return await client.callTool(actualToolName, input);
  };

  try {
    // Assemble context from palace (CAG — simplified for first skill)
    const contextParts: string[] = [];

    if (manifest.rooms?.retrieval_rooms) {
      for (const room of manifest.rooms.retrieval_rooms) {
        const drawers = await session.walkRoom(room, { limit: 10 });
        if (drawers.length > 0) {
          contextParts.push(
            `[Context from ${room.wing}/${room.hall}/${room.room}]:\n` +
            drawers.map((d) => d.content).join("\n---\n"),
          );
        }
      }
    }

    // Build the initial message
    const userMessage = contextParts.length > 0
      ? `${contextParts.join("\n\n")}\n\nNow proceed with the task.`
      : "Proceed with the task.";

    // Run the agentic loop
    console.log(`[nexaas] Running AI skill '${manifest.id}' with ${allTools.length} tools, model: ${model}`);

    const result = await runAgenticLoop({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: allTools,
      executeTool,
      maxTurns: 20,
      workspace,
      runId,
      skillId: manifest.id,
    });

    // Record the result as a palace drawer
    const primaryRoom = manifest.rooms?.primary ?? { wing: "operations", hall: "ai", room: manifest.id };
    await session.writeDrawer(primaryRoom, JSON.stringify({
      skill: manifest.id,
      success: true,
      turns: result.turns,
      tool_calls: result.toolCalls.length,
      content_preview: result.content.slice(0, 500),
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
    }));

    // Update token usage
    const cost = estimateCost(
      { provider: "anthropic", model, input_cost_per_m: tier === "good" ? 3 : 1, output_cost_per_m: tier === "good" ? 15 : 5 } as ModelEntry,
      result.inputTokens,
      result.outputTokens,
    );

    await runTracker.updateTokenUsage(runId, {
      input: result.inputTokens,
      output: result.outputTokens,
      cost_usd: cost,
    });

    await appendWal({
      workspace,
      op: "ai_skill_completed",
      actor: `skill:${manifest.id}`,
      payload: {
        run_id: runId,
        model,
        turns: result.turns,
        tool_calls: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: cost,
      },
    });

    await runTracker.markStepCompleted(runId, stepId);
    await runTracker.markCompleted(runId);

    console.log(`[nexaas] AI skill '${manifest.id}' completed: ${result.turns} turns, ${result.toolCalls.length} tool calls`);

    return {
      success: true,
      turns: result.turns,
      toolCalls: result.toolCalls.length,
      content: result.content,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await appendWal({
      workspace,
      op: "ai_skill_failed",
      actor: `skill:${manifest.id}`,
      payload: { run_id: runId, error: message },
    });

    await runTracker.markStepFailed(runId, stepId, err);

    console.error(`[nexaas] AI skill '${manifest.id}' failed:`, message);

    return { success: false, turns: 0, toolCalls: 0, content: message };
  } finally {
    // Disconnect all MCP clients
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
