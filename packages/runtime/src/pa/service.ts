/**
 * PA Service — Persona Agent for Nexaas.
 *
 * Receives inbound messages from any channel (Telegram, email, dashboard),
 * identifies the persona, enters the palace with the persona's scope,
 * runs the agentic loop, responds through the same channel, and records
 * everything in the palace.
 *
 * A PA can be:
 * - Human-facing: Mireille messages via Telegram, gets a context-aware response
 * - AI-autonomous: triggered by events, acts independently within its scope
 * - Hybrid: acts autonomously but escalates to humans when needed
 */

import { randomUUID } from "crypto";
import { palace, appendWal, sql } from "@nexaas/palace";
import { runAgenticLoop, type McpTool } from "../models/agentic-loop.js";
import { McpClient, loadMcpConfigs } from "../mcp/client.js";
import { runTracker } from "../run-tracker.js";

export interface PersonaConfig {
  id: string;
  displayName: string;
  type: "human-facing" | "ai-autonomous" | "hybrid";
  owner: string;
  modelTier: string;
  systemPrompt: string;
  mcpServers: string[];
  palaceAccess: {
    read: string[];   // room patterns: ["*"] or ["knowledge/*", "marketing/*"]
    deny: string[];   // denied rooms: ["accounting/*", "personas/other-pa/*"]
  };
  channels: string[];
  maxTurns?: number;
}

export interface InboundMessage {
  channel: string;           // telegram | email | dashboard
  senderId: string;          // telegram user ID, email address, etc.
  senderName: string;
  content: string;
  threadId?: string;         // for threaded conversations
  attachments?: Array<{ type: string; url: string }>;
}

const TIER_MAP: Record<string, string> = {
  cheap: "claude-haiku-4-5-20251001",
  good: "claude-sonnet-4-6",
  better: "claude-sonnet-4-6",
  best: "claude-opus-4-6",
};

export async function handlePaMessage(
  workspace: string,
  persona: PersonaConfig,
  message: InboundMessage,
): Promise<{ response: string; turns: number; toolCalls: number }> {
  const runId = randomUUID();
  const model = TIER_MAP[persona.modelTier] ?? "claude-sonnet-4-6";

  await runTracker.createRun({
    runId,
    workspace,
    skillId: `pa/${persona.id}`,
    triggerType: `inbound-message:${message.channel}`,
    triggerPayload: {
      sender: message.senderName,
      channel: message.channel,
      content_preview: message.content.slice(0, 100),
    },
  });

  await runTracker.markStepStarted(runId, "pa-respond");

  const session = palace.enter({
    workspace,
    runId,
    skillId: `pa/${persona.id}`,
    stepId: "pa-respond",
  });

  // Record the inbound message as a drawer
  await session.writeDrawer(
    { wing: "personas", hall: persona.id, room: "conversations" },
    JSON.stringify({
      direction: "inbound",
      channel: message.channel,
      sender: message.senderName,
      content: message.content,
      timestamp: new Date().toISOString(),
    }),
  );

  // Assemble context from the persona's palace scope
  const contextParts: string[] = [];

  // Load prior conversations for this persona (last 10)
  const priorConversations = await session.walkRoom(
    { wing: "personas", hall: persona.id, room: "conversations" },
    { limit: 10 },
  );
  if (priorConversations.length > 1) {
    contextParts.push(
      "[Prior conversation history]:\n" +
      priorConversations
        .reverse()
        .slice(0, -1) // exclude the message we just wrote
        .map((d) => d.content)
        .join("\n"),
    );
  }

  // Load persona preferences
  const preferences = await session.walkRoom(
    { wing: "personas", hall: persona.id, room: "preferences" },
    { limit: 5 },
  );
  if (preferences.length > 0) {
    contextParts.push(
      "[Persona preferences]:\n" +
      preferences.map((d) => d.content).join("\n"),
    );
  }

  // Load relevant workspace context based on palace access rules
  for (const pattern of persona.palaceAccess.read) {
    if (pattern === "*") {
      // Full access — load brand voice and workspace context as defaults
      const brandVoice = await session.walkRoom(
        { wing: "knowledge", hall: "brand", room: "voice" },
        { limit: 1 },
      );
      if (brandVoice.length > 0) {
        contextParts.push("[Brand voice]:\n" + brandVoice[0]!.content);
      }

      const wsContext = await session.walkRoom(
        { wing: "knowledge", hall: "context", room: "workspace-instructions" },
        { limit: 1 },
      );
      if (wsContext.length > 0) {
        contextParts.push("[Workspace context]:\n" + wsContext[0]!.content.slice(0, 2000));
      }
      break;
    }
  }

  // Connect to MCP servers
  const workspacePath = process.env.NEXAAS_WORKSPACE_ROOT ?? "";
  const mcpConfigs = loadMcpConfigs(workspacePath);
  const mcpClients: McpClient[] = [];
  const allTools: McpTool[] = [];

  for (const serverName of persona.mcpServers) {
    const config = mcpConfigs[serverName];
    if (!config) continue;

    const client = new McpClient(serverName, config);
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

  // Also add palace tools so the PA can search the palace during conversation
  allTools.push({
    name: "palace__search",
    description: "Search the workspace palace for relevant information",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        wing: { type: "string", description: "Limit to a specific wing (optional)" },
      },
      required: ["query"],
    },
  });

  allTools.push({
    name: "palace__context",
    description: "Read specific palace room content",
    input_schema: {
      type: "object",
      properties: {
        wing: { type: "string" },
        hall: { type: "string" },
        room: { type: "string" },
      },
      required: ["wing", "hall", "room"],
    },
  });

  // Tool executor
  const executeTool = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    // Palace tools
    if (toolName === "palace__search") {
      const query = input.query as string;
      const wing = input.wing as string | undefined;

      const conditions = [`workspace = $1`, `content ILIKE $2`];
      const params: unknown[] = [workspace, `%${query}%`];
      if (wing) { conditions.push(`wing = $3`); params.push(wing); }

      const results = await sql(
        `SELECT wing, hall, room, left(content, 300) as content
         FROM nexaas_memory.events
         WHERE ${conditions.join(" AND ")} AND wing IS NOT NULL
         ORDER BY created_at DESC LIMIT 5`,
        params,
      );
      return JSON.stringify(results);
    }

    if (toolName === "palace__context") {
      const drawers = await session.walkRoom(
        { wing: input.wing as string, hall: input.hall as string, room: input.room as string },
        { limit: 3 },
      );
      return drawers.map((d) => d.content).join("\n---\n") || "No content in this room.";
    }

    // MCP tools
    const parts = toolName.split("__");
    if (parts.length < 2) throw new Error(`Invalid tool name: ${toolName}`);
    const serverName = parts[0]!;
    const actualName = parts.slice(1).join("__");
    const client = mcpClients.find((c) => c["serverName"] === serverName);
    if (!client) throw new Error(`MCP not connected: ${serverName}`);
    return await client.callTool(actualName, input);
  };

  // Build the system prompt
  const systemPrompt = `${persona.systemPrompt}

You are ${persona.displayName}, a personal assistant for ${message.senderName}.
Channel: ${message.channel}
${contextParts.length > 0 ? "\n" + contextParts.join("\n\n") : ""}

SEARCH ESCALATION (CRITICAL — follow this for EVERY factual question):
1. SEARCH FIRST: Use palace__search to search the workspace records. Try multiple keywords if the first search returns nothing (e.g., for "TICO number" try "TICO", then "registration", then "license number").
2. BROADEN: If not found, search again without limiting to a specific area — search across all documents, knowledge, and records.
3. EXTERNAL: If the question is NOT about the business (weather, general knowledge, current events), use other available tools (fetch, weather, etc.).
4. ONLY THEN: If all searches return nothing, tell the user and offer to help them add the information.

NEVER say "I don't have that" or "I couldn't find that" without searching first. Users upload documents and expect you to find information in them.

Be helpful, context-aware, and follow the brand voice.`;

  try {
    const result = await runAgenticLoop({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: message.content }],
      tools: allTools,
      executeTool,
      maxTurns: persona.maxTurns ?? 15,
      workspace,
      runId,
      skillId: `pa/${persona.id}`,
    });

    // Record the response as a drawer
    await session.writeDrawer(
      { wing: "personas", hall: persona.id, room: "conversations" },
      JSON.stringify({
        direction: "outbound",
        channel: message.channel,
        recipient: message.senderName,
        content: result.content,
        turns: result.turns,
        tool_calls: result.toolCalls.length,
        timestamp: new Date().toISOString(),
      }),
    );

    await appendWal({
      workspace,
      op: "pa_message_handled",
      actor: `pa/${persona.id}`,
      payload: {
        run_id: runId,
        channel: message.channel,
        sender: message.senderName,
        turns: result.turns,
        tool_calls: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      },
    });

    await runTracker.markStepCompleted(runId, "pa-respond");
    await runTracker.markCompleted(runId);

    return {
      response: result.content,
      turns: result.turns,
      toolCalls: result.toolCalls.length,
    };
  } catch (err) {
    const message_text = err instanceof Error ? err.message : String(err);
    await runTracker.markStepFailed(runId, "pa-respond", err);

    return {
      response: `I'm sorry, I encountered an error. Please try again. (${message_text})`,
      turns: 0,
      toolCalls: 0,
    };
  } finally {
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
