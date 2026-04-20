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
      const queryText = input.query as string;
      const wing = input.wing as string | undefined;

      // Try semantic search first (vector similarity)
      try {
        const { embedText } = await import("../ingest/embedder.js");
        const { searchSimilar } = await import("@nexaas/palace");
        const queryEmb = await embedText(queryText);

        const semanticResults = await searchSimilar(workspace, queryEmb, {
          limit: 8,
          minSimilarity: 0.3,
        });

        if (semanticResults.length > 0) {
          return JSON.stringify(semanticResults.map(r => ({
            wing: r.wing, hall: r.hall, room: r.room,
            content: r.content.slice(0, 1500),
            similarity: Math.round(r.similarity * 100) + "%",
          })));
        }
      } catch {
        // Embeddings not available — fall through to text search
      }

      // Fallback: text search across all content including chunks
      const conditions = [`workspace = $1`, `content ILIKE $2`];
      const params: unknown[] = [workspace, `%${queryText}%`];
      if (wing) { conditions.push(`wing = $3`); params.push(wing); }

      const results = await sql(
        `SELECT wing, hall, room, left(content, 1500) as content
         FROM nexaas_memory.events
         WHERE ${conditions.join(" AND ")} AND wing IS NOT NULL
         ORDER BY created_at DESC LIMIT 8`,
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

MANDATORY SEARCH-FIRST RULE:
You MUST call palace__search BEFORE answering ANY question — even if you think you know the answer from general knowledge. The user's uploaded documents, records, and business data take priority over your training data. Your general knowledge is a FALLBACK, not the primary source.

SEARCH ESCALATION:
1. ALWAYS SEARCH FIRST: Call palace__search with relevant keywords from the user's question. Do this for EVERY question, no exceptions. Even "What is Club Med Bali?" should search first because the user may have a brochure with specific details.
2. TRY MULTIPLE SEARCHES: If the first search returns nothing, try different keywords. For "Club Med Bali" try "Club Med", then "Bali", then "resort".
3. USE WHAT YOU FIND: If the search returns results, base your answer on those results — cite the document name when relevant ("According to your Exclusive Collection Brochure...").
4. SUPPLEMENT WITH KNOWLEDGE: If the search found partial info, you may add general knowledge to complement it, but always lead with what's in the records.
5. EXTERNAL TOOLS: For non-business questions (weather, current events), use fetch or other tools.
6. LAST RESORT: Only if all searches return nothing AND the question is about business data, say you couldn't find it and suggest uploading the relevant document.

The user has uploaded documents specifically so you can reference them. Ignoring them in favor of general knowledge is a failure.

Be helpful, context-aware, and follow the brand voice.`;

  try {
    // Overall request timeout — prevents a wedged tool call or slow
    // Anthropic response from holding the HTTP handler indefinitely.
    // Default 2 min; override via NEXAAS_PA_TIMEOUT_MS.
    const paTimeoutMs = parseInt(process.env.NEXAAS_PA_TIMEOUT_MS ?? "120000", 10);
    const result = await Promise.race([
      runAgenticLoop({
        model,
        system: systemPrompt,
        messages: [{ role: "user", content: message.content }],
        tools: allTools,
        executeTool,
        maxTurns: persona.maxTurns ?? 15,
        workspace,
        runId,
        skillId: `pa/${persona.id}`,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`pa handler timed out after ${Math.round(paTimeoutMs / 1000)}s`)),
          paTimeoutMs,
        ),
      ),
    ]);

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
        cache_creation_input_tokens: result.cacheCreationTokens,
        cache_read_input_tokens: result.cacheReadTokens,
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
