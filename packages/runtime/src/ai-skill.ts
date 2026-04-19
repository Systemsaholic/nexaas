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
import { spawnSync } from "child_process";
import { palace, appendWal } from "@nexaas/palace";
import { runTracker } from "./run-tracker.js";
import { McpClient, loadMcpConfigs } from "./mcp/client.js";
import { runAgenticLoop, type McpTool, type AgenticLimits } from "./models/agentic-loop.js";
import { resolveTier, estimateCost, type ModelEntry } from "./models/registry.js";
import { verifyOutputs, summarizeFailures, type OutputVerification } from "./ai-skill-verify.js";

export interface AiSkillManifest {
  id: string;
  version: string;
  description?: string;
  execution: {
    type: "ai-skill";
    model_tier?: string;
    /**
     * Optional cheap shell check that decides whether the AI loop runs.
     * Exit 0 → proceed. Exit 1 → skip (status='skipped', $0 cost). Exit ≥2 → fail.
     * Runs before MCP connect so a skipped run pays nothing.
     */
    preflight?: {
      command: string;
      timeout?: number;
      working_directory?: string;
    };
  };
  mcp_servers?: string[];
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
    retrieval_rooms?: Array<{ wing: string; hall: string; room: string }>;
  };
  outputs?: Array<{
    id: string;
    routing_default: string;
    verify?: OutputVerification;
  }>;
  self_reflection?: boolean;
  limits?: {
    max_turns?: number;
    max_spend_usd?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    max_output_tokens_per_turn?: number;
    max_consecutive_identical_tool_calls?: number;
    max_consecutive_errors?: number;
  };
}

const DEFAULT_LIMITS: Required<Pick<AiSkillManifest, "limits">>["limits"] = {
  max_turns: 10,
  max_spend_usd: 2.0,
  max_output_tokens_per_turn: 16000,
  max_consecutive_identical_tool_calls: 3,
  max_consecutive_errors: 3,
};

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

  // Preflight gate — run before any MCP / model cost. See issue #30.
  const preflight = manifest.execution.preflight;
  if (preflight?.command) {
    const preflightStart = Date.now();
    const result = spawnSync(preflight.command, {
      shell: true,
      encoding: "utf-8",
      cwd: preflight.working_directory,
      timeout: (preflight.timeout ?? 30) * 1000,
      env: { ...process.env, NEXAAS_RUN_ID: runId, NEXAAS_SKILL_ID: manifest.id },
    });
    const preflightMs = Date.now() - preflightStart;
    const exitCode = result.status ?? (result.signal ? 124 : 1);
    const stderr = (result.stderr ?? "").toString();
    const stdout = (result.stdout ?? "").toString();

    if (exitCode === 0) {
      await appendWal({
        workspace,
        op: "ai_skill_preflight_passed",
        actor: `skill:${manifest.id}`,
        payload: { run_id: runId, duration_ms: preflightMs },
      });
    } else if (exitCode === 1) {
      const reason = (stdout.trim() || stderr.trim() || "preflight returned 1").slice(0, 500);
      const room = manifest.rooms?.primary ?? { wing: "operations", hall: "ai", room: manifest.id };
      await session.writeDrawer(room, JSON.stringify({
        skill: manifest.id,
        success: true,
        skipped: true,
        reason,
        duration_ms: preflightMs,
      }));
      await appendWal({
        workspace,
        op: "ai_skill_skipped",
        actor: `skill:${manifest.id}`,
        payload: { run_id: runId, reason, duration_ms: preflightMs },
      });
      await runTracker.markStepCompleted(runId, stepId);
      await runTracker.markSkipped(runId, reason);
      console.log(`[nexaas] AI skill '${manifest.id}' skipped by preflight: ${reason}`);
      return { success: true, turns: 0, toolCalls: 0, content: `skipped: ${reason}` };
    } else {
      const errSummary = (stderr.trim() || stdout.trim() || `preflight exited ${exitCode}`).slice(0, 500);
      await appendWal({
        workspace,
        op: "ai_skill_preflight_failed",
        actor: `skill:${manifest.id}`,
        payload: { run_id: runId, exit_code: exitCode, error: errSummary, duration_ms: preflightMs },
      });
      await runTracker.markStepFailed(runId, stepId, `preflight exit ${exitCode}: ${errSummary}`);
      console.error(`[nexaas] AI skill '${manifest.id}' preflight failed (exit ${exitCode}): ${errSummary}`);
      return { success: false, turns: 0, toolCalls: 0, content: errSummary };
    }
  }

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

    // Resolve pricing from the model registry for real spend-cap enforcement.
    let modelPricing: { inputCostPerM: number; outputCostPerM: number } | undefined;
    let pricedModelEntry: ModelEntry | undefined;
    try {
      const resolved = resolveTier(tier);
      pricedModelEntry = resolved.primary;
      if (resolved.primary.input_cost_per_m != null && resolved.primary.output_cost_per_m != null) {
        modelPricing = {
          inputCostPerM: resolved.primary.input_cost_per_m,
          outputCostPerM: resolved.primary.output_cost_per_m,
        };
      }
    } catch { /* registry not available — spend cap will be skipped */ }

    // Merge manifest limits with defaults.
    const m = manifest.limits ?? {};
    const agenticLimits: AgenticLimits = {
      maxTurns: m.max_turns ?? DEFAULT_LIMITS.max_turns,
      maxSpendUsd: m.max_spend_usd ?? DEFAULT_LIMITS.max_spend_usd,
      maxInputTokens: m.max_input_tokens,
      maxOutputTokens: m.max_output_tokens,
      maxOutputTokensPerTurn: m.max_output_tokens_per_turn ?? DEFAULT_LIMITS.max_output_tokens_per_turn,
      maxConsecutiveIdenticalToolCalls:
        m.max_consecutive_identical_tool_calls ?? DEFAULT_LIMITS.max_consecutive_identical_tool_calls,
      maxConsecutiveErrors: m.max_consecutive_errors ?? DEFAULT_LIMITS.max_consecutive_errors,
    };

    // Run the agentic loop
    console.log(`[nexaas] Running AI skill '${manifest.id}' with ${allTools.length} tools, model: ${model}`);

    const result = await runAgenticLoop({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      tools: allTools,
      executeTool,
      workspace,
      runId,
      skillId: manifest.id,
      limits: agenticLimits,
      modelPricing,
    });

    // Record the result as a palace drawer
    const primaryRoom = manifest.rooms?.primary ?? { wing: "operations", hall: "ai", room: manifest.id };
    await session.writeDrawer(primaryRoom, JSON.stringify({
      skill: manifest.id,
      success: !result.aborted,
      stop_reason: result.stopReason,
      aborted: result.aborted,
      turns: result.turns,
      tool_calls: result.toolCalls.length,
      content_preview: result.content.slice(0, 500),
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd: result.costUsd,
    }));

    // Update token usage — prefer registry-sourced pricing, fall back to previous guess.
    const cost = pricedModelEntry
      ? estimateCost(pricedModelEntry, result.inputTokens, result.outputTokens)
      : estimateCost(
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
      op: result.aborted ? "ai_skill_aborted" : "ai_skill_completed",
      actor: `skill:${manifest.id}`,
      payload: {
        run_id: runId,
        model,
        turns: result.turns,
        tool_calls: result.toolCalls.length,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: cost,
        stop_reason: result.stopReason,
        aborted: result.aborted,
      },
    });

    // Write to token_usage table for billing dashboard
    try {
      const { sql } = await import("@nexaas/palace");
      await sql(
        `INSERT INTO token_usage (workspace, agent, session_id, source, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [workspace, manifest.id, runId, "ai-skill", model, result.inputTokens, result.outputTokens, cost],
      );
    } catch { /* non-fatal — billing table may not exist on all installs */ }

    await runTracker.markStepCompleted(runId, stepId);

    // Output verification (#28) — only when the loop wasn't already aborted.
    // A skill that declares `outputs[].verify` gets checked here before the
    // run is marked complete.
    const verifiableOutputs = (manifest.outputs ?? []).filter((o) => o.verify);
    let verificationFailed = false;
    let verificationSummary = "";
    if (!result.aborted && verifiableOutputs.length > 0) {
      const vResults = await verifyOutputs({
        workspace,
        runId,
        skillId: manifest.id,
        outputs: verifiableOutputs,
        primaryRoom,
        toolCalls: result.toolCalls,
      });
      const { requiredFailures, optionalFailures } = summarizeFailures(vResults);

      await appendWal({
        workspace,
        op: "ai_skill_verification",
        actor: `skill:${manifest.id}`,
        payload: {
          run_id: runId,
          results: vResults,
          required_failures: requiredFailures.length,
          optional_failures: optionalFailures.length,
        },
      });

      await session.writeDrawer(primaryRoom, JSON.stringify({
        skill: manifest.id,
        kind: "verification",
        results: vResults,
      }));

      for (const f of optionalFailures) {
        console.warn(
          `[nexaas] AI skill '${manifest.id}' output '${f.outputId}' verification failed (optional): ${f.reason}`,
        );
      }

      if (requiredFailures.length > 0) {
        verificationFailed = true;
        verificationSummary = requiredFailures
          .map((f) => `output '${f.outputId}' (${f.type}): ${f.reason}`)
          .join("; ");
      }
    }

    if (result.aborted) {
      await runTracker.markStepFailed(runId, stepId, `agentic loop aborted: ${result.stopReason}`);
      console.warn(
        `[nexaas] AI skill '${manifest.id}' aborted (${result.stopReason}): ${result.turns} turns, $${result.costUsd.toFixed(4)}`,
      );
    } else if (verificationFailed) {
      await runTracker.markStepFailed(runId, stepId, `output verification failed: ${verificationSummary}`);
      console.warn(
        `[nexaas] AI skill '${manifest.id}' verification failed: ${verificationSummary}`,
      );
    } else {
      await runTracker.markCompleted(runId);
      console.log(
        `[nexaas] AI skill '${manifest.id}' completed: ${result.turns} turns, ${result.toolCalls.length} tool calls`,
      );
    }

    return {
      success: !result.aborted && !verificationFailed,
      turns: result.turns,
      toolCalls: result.toolCalls.length,
      content: result.content,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;

    await appendWal({
      workspace,
      op: status === 429 ? "ai_skill_rate_limited" : "ai_skill_failed",
      actor: `skill:${manifest.id}`,
      payload: { run_id: runId, error: message, status },
    });

    await runTracker.markStepFailed(runId, stepId, err);

    // Rethrow 429s so the worker layer can pause the workspace queue for
    // the cooldown window declared in the response headers (see #27).
    // Other errors stay non-throwing — callers see `success: false`.
    if (status === 429) {
      console.warn(`[nexaas] AI skill '${manifest.id}' hit rate limit — rethrowing for queue backoff`);
      for (const client of mcpClients) {
        try { await client.disconnect(); } catch { /* ignore */ }
      }
      mcpClients.length = 0;
      throw err;
    }

    console.error(`[nexaas] AI skill '${manifest.id}' failed:`, message);

    return { success: false, turns: 0, toolCalls: 0, content: message };
  } finally {
    // Disconnect all MCP clients
    for (const client of mcpClients) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
