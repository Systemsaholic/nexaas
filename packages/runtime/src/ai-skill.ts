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
import { acquireMcpClient, releaseMcpClient } from "./mcp/pool.js";
import { runAgenticLoop, type McpTool, type AgenticLimits } from "./models/agentic-loop.js";
import { resolveTier, estimateCost, type ModelEntry } from "./models/registry.js";
import { verifyOutputs, summarizeFailures, type OutputVerification } from "./ai-skill-verify.js";
import type { OutputKind, ManifestApproval, RoutingDecision } from "./tag/route.js";
import { apply as applyRoutedAction } from "./engine/apply.js";
import { loadWorkspaceManifest } from "./schemas/load-manifest.js";
import {
  buildFrameworkTools,
  executeFrameworkTool,
  isFrameworkTool,
  type FrameworkToolContext,
} from "./ai-skill-framework-tools.js";

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
    /**
     * Optional TAG bridge (#45 Stage 1b). When set, the agentic loop's
     * result is routed through TAG as if it were an output payload — if
     * the matching output has `routing_default: approval_required`,
     * engine.apply creates a waitpoint + approval-request drawer.
     * `auto_execute` writes the primary drawer (existing behavior).
     *
     * For skills that don't declare primary_output, behavior is
     * unchanged from before Stage 1b — the primary drawer is written
     * directly without TAG routing.
     */
    primary_output?: string;
  };
  mcp_servers?: string[];
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
    retrieval_rooms?: Array<{ wing: string; hall: string; room: string }>;
  };
  outputs?: Array<{
    id: string;
    kind?: OutputKind;
    routing_default: string;
    approval?: ManifestApproval;
    notify?: { channel_role: string; timeout?: string };
    verify?: OutputVerification;
    /**
     * Per-output format hint for `kind: notification` outputs routed via
     * the primary_output auto-map (#61). Values: "plain" | "markdown"
     * | "html" — framework-canonical per messaging-outbound v0.2 (#38).
     * Channel adapters map to native dialects (Telegram MarkdownV2 /
     * HTML, Slack mrkdwn, etc.). Missing defaults to "plain".
     *
     * Not needed on produce_output calls — AI declares parse_mode at
     * call time in the tool payload.
     */
    parse_mode?: "plain" | "markdown" | "html";
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
  /**
   * Optional mutex groups. Skills declaring overlapping group names
   * serialize within the worker; non-overlapping skills parallelize.
   * See docs/rfcs/0001-skill-concurrency-groups.md.
   */
  concurrency_groups?: string[];
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

export interface AiSkillExecutionContext {
  runId?: string;
  stepId?: string;
  triggerType?: string;
  triggerPayload?: Record<string, unknown>;
}

export async function runAiSkill(
  workspace: string,
  manifest: AiSkillManifest,
  manifestPath: string,
  context?: AiSkillExecutionContext,
): Promise<{ success: boolean; turns: number; toolCalls: number; content: string }> {
  // Reuse BullMQ job context when the dispatcher supplied one so a single
  // logical skill invocation carries one run_id end-to-end (#47). Falls
  // back to a fresh id for direct callers (tests, CLI trigger-skill).
  const runId = context?.runId ?? randomUUID();
  const stepId = context?.stepId ?? "ai-exec";
  const triggerType = context?.triggerType ?? "cron";
  const triggerPayload = context?.triggerPayload;

  try {
    await runTracker.createRun({
      runId,
      workspace,
      skillId: manifest.id,
      skillVersion: manifest.version,
      triggerType,
      triggerPayload,
    });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code !== "23505") throw err;
  }

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

      try {
        // acquireMcpClient transparently returns a pooled long-lived client
        // when NEXAAS_MCP_POOL_ENABLED is set, or spawns fresh otherwise
        // (legacy behavior). See packages/runtime/src/mcp/pool.ts (#63).
        const client = await acquireMcpClient(serverName, config);
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

  // Framework-level tools (#60) — inject produce_output if the skill
  // declares any outputs. The handler runs in-process, not via MCP.
  const frameworkToolsState = { producedOutputs: [] as string[] };
  let frameworkToolsCtx: FrameworkToolContext | null = null;  // bound later when session is ready
  for (const t of buildFrameworkTools(manifest)) {
    allTools.push(t);
  }

  // Tool executor — framework__* calls are handled in-process; everything
  // else routes to the matching MCP client.
  const executeTool = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    if (isFrameworkTool(toolName)) {
      if (!frameworkToolsCtx) throw new Error("framework tools called before context was bound");
      return await executeFrameworkTool(toolName, input, frameworkToolsCtx);
    }

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

    // Bind framework tool context now that session + manifest loader are
    // ready. Loaded once per run so the same workspaceManifest is available
    // both during the agentic loop (via framework__produce_output) and
    // after (for Stage 1b primary_output auto-map).
    const { manifest: workspaceManifestForRun } = await loadWorkspaceManifest(workspace);
    frameworkToolsCtx = {
      manifest,
      session,
      runId,
      stepId,
      workspace,
      workspaceManifest: workspaceManifestForRun,
      state: frameworkToolsState,
    };

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
    const primaryDrawerPayload = {
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
    };

    // #45 Stage 1b — TAG bridge. If the manifest declares a
    // primary_output pointing at an outputs[] entry, route the agentic
    // loop's result through engine.apply() per the declared routing.
    // Without primary_output, behavior is unchanged (direct drawer write).
    //
    // #60 — if any framework__produce_output calls fired during the
    // loop, suppress primary_output auto-map. Explicit beats implicit:
    // the AI used typed outputs, don't double-route the final text.
    const primaryOutputId = manifest.execution.primary_output;
    const primaryOutput = primaryOutputId
      ? (manifest.outputs ?? []).find((o) => o.id === primaryOutputId)
      : undefined;
    const skipPrimaryAutoMap = frameworkToolsState.producedOutputs.length > 0;

    if (skipPrimaryAutoMap && primaryOutput) {
      console.log(
        `[nexaas] Skipping primary_output auto-map for '${manifest.id}' — ${frameworkToolsState.producedOutputs.length} explicit produce_output call(s): ${frameworkToolsState.producedOutputs.join(", ")}`,
      );
    }

    if (!result.aborted && primaryOutput && !skipPrimaryAutoMap) {
      const routing = (primaryOutput.routing_default as RoutingDecision) ?? "auto_execute";
      const workspaceManifest = workspaceManifestForRun;
      await applyRoutedAction(
        {
          action: {
            kind: primaryOutput.id,
            payload: {
              ...primaryDrawerPayload,
              content: result.content,
              // #61 — manifest-declared parse_mode flows through the
              // notification envelope. engine.apply reads payload.parse_mode
              // for kind: notification auto_execute; #40 dispatcher forwards
              // to the MCP send tool.
              ...(primaryOutput.parse_mode ? { parse_mode: primaryOutput.parse_mode } : {}),
              tool_calls_detail: result.toolCalls.map((tc) => ({
                name: tc.name,
                // Truncate input; full input is already in the WAL per-turn entries.
                input_keys: Object.keys(tc.input),
              })),
            },
          },
          routing,
          source: `ai-skill-primary-output:${primaryOutput.id}`,
          approval: primaryOutput.approval,
          notify: primaryOutput.notify as { channel_role: string; timeout?: string } | undefined,
          output_kind: primaryOutput.kind,
        },
        {
          session,
          runId,
          stepId,
          workspaceManifest,
        },
      );

      // auto_execute writes a drawer via engine.apply already (to
      // events.skill.executed). For ai-skill we still want the canonical
      // per-skill primary drawer so dashboards keep finding skill output
      // at manifest.rooms.primary. Write it alongside.
      if (routing === "auto_execute") {
        await session.writeDrawer(primaryRoom, JSON.stringify(primaryDrawerPayload));
      }
    } else {
      // Fallback: write the canonical primary drawer directly. Runs if:
      //   - no primary_output declared (Stage 1b opt-in), OR
      //   - run aborted (primary_output would've been meaningless), OR
      //   - produce_output fired (we skipped primary auto-map but still
      //     want the per-skill run summary drawer for dashboards)
      await session.writeDrawer(primaryRoom, JSON.stringify(primaryDrawerPayload));
    }

    // Update token usage — prefer registry-sourced pricing, fall back to previous guess.
    const cost = pricedModelEntry
      ? estimateCost(
          pricedModelEntry, result.inputTokens, result.outputTokens,
          result.cacheCreationTokens, result.cacheReadTokens,
        )
      : estimateCost(
          { provider: "anthropic", model, input_cost_per_m: tier === "good" ? 3 : 1, output_cost_per_m: tier === "good" ? 15 : 5 } as ModelEntry,
          result.inputTokens,
          result.outputTokens,
          result.cacheCreationTokens,
          result.cacheReadTokens,
        );

    await runTracker.updateTokenUsage(runId, {
      input: result.inputTokens,
      output: result.outputTokens,
      cache_creation: result.cacheCreationTokens,
      cache_read: result.cacheReadTokens,
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
        cache_creation_input_tokens: result.cacheCreationTokens,
        cache_read_input_tokens: result.cacheReadTokens,
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
        try { await releaseMcpClient(client); } catch { /* ignore */ }
      }
      mcpClients.length = 0;
      throw err;
    }

    console.error(`[nexaas] AI skill '${manifest.id}' failed:`, message);

    return { success: false, turns: 0, toolCalls: 0, content: message };
  } finally {
    // Disconnect all MCP clients
    for (const client of mcpClients) {
      try { await releaseMcpClient(client); } catch { /* ignore */ }
    }
  }
}
