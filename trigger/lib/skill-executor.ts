/**
 * Standard skill execution function.
 *
 * ALL skill tasks MUST call executeSkill(). This function:
 * 1. Reads contract.yaml to get MCP server requirements
 * 2. Renders system-prompt.hbs with CAG context
 * 3. Calls runClaude() with contract-declared MCP servers (ENFORCEMENT)
 * 4. Logs to activity_log and token_usage
 *
 * Task code has NO way to specify or override MCP servers.
 * They ALWAYS come from the skill contract.
 */

import { logger, wait } from "@trigger.dev/sdk/v3";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { runClaude, type ClaudeResult } from "./claude.js";
import { renderTemplate } from "./template-renderer.js";
import { logSkillActivity, logSkillTokenUsage } from "./skill-logger.js";
import { resolveChannel, type ChannelRequirement } from "../../orchestrator/channels/resolver.js";
import { deliver } from "../../orchestrator/channels/deliver.js";
import { storeFeedbackEvent } from "../../orchestrator/feedback/events.js";
import { retrieveRelevantDocs } from "../../orchestrator/rag/client.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export interface SkillPayload {
  /** Skill ID: "category/name" (e.g., "operations/weather-forecast") */
  skillId: string;
  /** Workspace ID from env or payload */
  workspaceId: string;
  /** Skill-specific input (location, email, query, etc.) */
  input: Record<string, unknown>;
  /** Optional model override (defaults to contract.execution.model) */
  model?: string;
}

export interface SkillResult {
  success: boolean;
  output: string;
  parsed: Record<string, unknown> | null;
  tokens: { input: number; output: number };
  model: string;
  durationMs: number;
  error?: string;
  approval?: {
    required: boolean;
    approved: boolean;
    clientResponse?: Record<string, unknown>;
  };
}

export interface ApprovalResponse {
  approved: boolean;
  comment?: string;
  modifiedInput?: Record<string, unknown>;
}

interface SkillContract {
  skill: string;
  version: string;
  type: "simple" | "agentic";
  description: string;
  execution: {
    type: string;
    model: string;
    max_tokens: number;
    timeout_seconds: number;
  };
  mcp_servers: string[];
  reads_from_context: string[];
  produces: string[];
  tag_defaults: Record<string, unknown>;
}

export async function executeSkill(payload: SkillPayload): Promise<SkillResult> {
  const { skillId, workspaceId, input } = payload;
  const [category, name] = skillId.split("/");
  const skillDir = join(NEXAAS_ROOT, "skills", category, name);

  logger.info(`Executing skill: ${skillId} for ${workspaceId}`);

  // 1. Read and parse contract.yaml
  const contractPath = join(skillDir, "contract.yaml");
  if (!existsSync(contractPath)) {
    const error = `Skill contract not found: ${contractPath}`;
    logger.error(error);
    await logSkillActivity(workspaceId, skillId, "error", error, "flag");
    return { success: false, output: "", parsed: null, tokens: { input: 0, output: 0 }, model: "", durationMs: 0, error };
  }

  const contract = yaml.load(readFileSync(contractPath, "utf-8")) as SkillContract;
  const mcpServers = contract.mcp_servers ?? [];
  const model = payload.model ?? contract.execution?.model ?? "sonnet";
  const timeoutMs = (contract.execution?.timeout_seconds ?? 60) * 1000;

  logger.info(`Contract: type=${contract.type}, mcp=${mcpServers.join(",") || "none"}, model=${model}`);

  // 2. Build CAG context + RAG retrieval
  const cagContext = buildCagContext(workspaceId, skillId, input);

  // RAG: retrieve relevant docs from Qdrant (cascade search)
  const ragConfig = (contract as any).rag ?? {};
  try {
    const ragQuery = Object.values(input).filter((v) => typeof v === "string").join(" ").slice(0, 500);
    if (ragQuery) {
      const ragChunks = await retrieveRelevantDocs(ragQuery, {
        clientNamespace: (ragConfig.primary ?? `${workspaceId}_knowledge`).replace("[tenant]", workspaceId),
        skillDocsNamespace: ragConfig.skill_docs?.replace("[tenant]", workspaceId),
        fallbackNamespace: ragConfig.fallback,
        limit: ragConfig.limit ?? 3,
        minRelevance: ragConfig.min_relevance ?? 0.5,
      });
      cagContext.ragChunks = ragChunks;
      if (ragChunks.length > 0) {
        logger.info(`RAG: retrieved ${ragChunks.length} chunks for ${skillId}`);
      }
    }
  } catch (e) {
    logger.warn(`RAG retrieval failed: ${(e as Error).message} — continuing without RAG`);
  }

  // Render system prompt from template with full context
  let systemPrompt = "";
  const templatePath = join(skillDir, "system-prompt.hbs");
  if (existsSync(templatePath)) {
    systemPrompt = renderTemplate(templatePath, cagContext);
  }

  // 3. Build user prompt from input
  const userPrompt = buildUserPrompt(skillId, input);

  // 4. Combine system prompt + user prompt for Claude
  const fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n\nUser request:\n${userPrompt}`
    : userPrompt;

  // 5. Call runClaude with contract-declared MCP servers (THE ENFORCEMENT POINT)
  let result: ClaudeResult;
  try {
    result = await runClaude({
      prompt: fullPrompt,
      mcpServers,  // ALWAYS from contract — task code cannot override
      model,
      timeoutMs,
      cwd: NEXAAS_ROOT,
      workspaceRoot: NEXAAS_ROOT,  // .mcp.json lives here
    });
  } catch (e) {
    const error = `runClaude failed: ${(e as Error).message}`;
    logger.error(error);
    await logSkillActivity(workspaceId, skillId, "error", error, "flag");
    return { success: false, output: "", parsed: null, tokens: { input: 0, output: 0 }, model, durationMs: 0, error };
  }

  if (!result.success) {
    await logSkillActivity(workspaceId, skillId, "error", result.error ?? "Skill execution failed", "flag", { output: result.output });
    return { success: false, output: result.output, parsed: null, tokens: result.tokens, model: result.model, durationMs: result.durationMs, error: result.error };
  }

  // 6. Parse output (strip markdown fences, extract JSON)
  const parsed = parseSkillOutput(result.output);

  // 7. Determine TAG route and summary
  const summary = parsed?.summary ?? result.output.slice(0, 200);
  const tagRoute = determineTagRoute(parsed, contract);

  // 8. Log token usage (always, regardless of approval)
  await logSkillTokenUsage(workspaceId, skillId, result.model, result.tokens.input, result.tokens.output);

  // 9. APPROVAL GATE — if TAG says approval_required, pause and wait for client
  if (tagRoute === "approval_required") {
    logger.info(`Skill ${skillId} requires approval — creating waitpoint`);

    // Create a Trigger.dev wait token
    const token = await wait.createToken({
      idempotencyKey: `skill-approval-${workspaceId}-${skillId}-${Date.now()}`,
      timeout: "7d",
      tags: [`workspace:${workspaceId}`, `skill:${skillId}`],
    });

    // Write to pending_approvals so client sees it in their dashboard
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `INSERT INTO pending_approvals
         (workspace_id, skill_id, action_type, summary, details, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW() + INTERVAL '7 days', NOW())`,
        [
          workspaceId,
          skillId,
          contract.skill,
          typeof summary === "string" ? summary : String(summary),
          JSON.stringify({
            ...parsed,
            waitTokenId: token.id,
            tokens_used: result.tokens.input + result.tokens.output,
          }),
        ]
      );
    } finally {
      await pool.end();
    }

    await logSkillActivity(
      workspaceId, skillId, contract.skill,
      `Awaiting approval: ${typeof summary === "string" ? summary : String(summary)}`,
      "approval_required",
      { ...parsed, waitTokenId: token.id },
    );

    logger.info(`Approval request created — waiting for client response (token: ${token.id})`);

    // PAUSE — task waits here until client responds or timeout
    const approval = await wait.forToken<ApprovalResponse>(token);

    if (!approval.ok) {
      // Timed out
      await storeFeedbackEvent({
        workspaceId, skillId, source: "user", feedbackType: "timeout",
        originalOutput: result.output, downstreamAction: "expired",
      });
      await logSkillActivity(workspaceId, skillId, contract.skill, "Approval expired — no response", "flag");
      return {
        success: false, output: result.output, parsed, tokens: result.tokens,
        model: result.model, durationMs: result.durationMs,
        error: "Approval timed out",
        approval: { required: true, approved: false },
      };
    }

    if (!approval.output.approved) {
      // Client rejected — store feedback event with reason
      await storeFeedbackEvent({
        workspaceId, skillId, source: "user", feedbackType: "reject",
        originalOutput: result.output,
        feedbackValue: approval.output.comment ?? "Rejected without comment",
        downstreamAction: "discarded",
      });
      await logSkillActivity(
        workspaceId, skillId, contract.skill,
        `Rejected by client${approval.output.comment ? `: ${approval.output.comment}` : ""}`,
        "flag",
      );
      return {
        success: true, output: result.output, parsed, tokens: result.tokens,
        model: result.model, durationMs: result.durationMs,
        approval: { required: true, approved: false, clientResponse: approval.output as unknown as Record<string, unknown> },
      };
    }

    // Client approved — store feedback event with delta if edited
    const editedOutput = (approval.output as any).editedOutput as string | undefined;
    await storeFeedbackEvent({
      workspaceId, skillId, source: "user",
      feedbackType: editedOutput ? "edit" : "approve",
      originalOutput: result.output,
      editedOutput: editedOutput ?? undefined,
      feedbackValue: approval.output.comment ?? undefined,
      downstreamAction: "executed",
    });

    logger.info(`Skill ${skillId} approved by client`);
    await logSkillActivity(
      workspaceId, skillId, contract.skill,
      typeof summary === "string" ? summary : String(summary),
      "auto_execute",
      { ...parsed, approved: true, clientComment: approval.output.comment, tokens_used: result.tokens.input + result.tokens.output },
    );

    return {
      success: true, output: result.output, parsed, tokens: result.tokens,
      model: result.model, durationMs: result.durationMs,
      approval: { required: true, approved: true, clientResponse: approval.output as unknown as Record<string, unknown> },
    };
  }

  // 10. Route via TAG — each route has different delivery behavior
  const summaryStr = typeof summary === "string" ? summary : String(summary);
  const detailsObj = { ...parsed, tokens_used: result.tokens.input + result.tokens.output };

  if (tagRoute === "notify_after") {
    // Execute + notify client via their preferred channel
    await logSkillActivity(workspaceId, skillId, contract.skill, summaryStr, tagRoute, detailsObj);

    const notifyChannel = await resolveChannel(workspaceId,
      { direction: "one-way", criticality: "standard" },
      { preferenceType: "briefing" }
    );
    if (notifyChannel) {
      await deliver({
        workspaceId, skillId, channel: notifyChannel.channel,
        type: "notification", summary: summaryStr,
        body: result.output.slice(0, 500),
        details: detailsObj,
      });
    }
  } else if (tagRoute === "escalate") {
    // Forward to escalation target via their preferred channel
    const escalationTarget = (contract as any).escalation_rules?.financial
      ?? (parsed?.escalation_target as string | undefined);

    await logSkillActivity(workspaceId, skillId, contract.skill,
      `Escalated: ${summaryStr}`, tagRoute, { ...detailsObj, escalation_target: escalationTarget });

    const escalateChannel = await resolveChannel(workspaceId,
      { direction: "two-way", criticality: "mission-critical" },
      { targetEmail: escalationTarget, preferenceType: "urgent" }
    );
    if (escalateChannel) {
      await deliver({
        workspaceId, skillId, channel: escalateChannel.channel,
        type: "escalation", summary: `Escalation: ${summaryStr}`,
        body: result.output.slice(0, 1000),
        details: detailsObj,
        targetEmail: escalationTarget,
      });
    }
  } else if (tagRoute === "flag") {
    // Suspend + notify primary contact + operator alert
    await logSkillActivity(workspaceId, skillId, contract.skill,
      `Flagged for review: ${summaryStr}`, tagRoute, detailsObj);

    const flagChannel = await resolveChannel(workspaceId,
      { direction: "two-way", criticality: "mission-critical", capabilities: ["interactive-buttons"] },
      { preferenceType: "urgent" }
    );
    if (flagChannel) {
      await deliver({
        workspaceId, skillId, channel: flagChannel.channel,
        type: "alert", summary: `Review required: ${summaryStr}`,
        body: result.output.slice(0, 1000),
        details: detailsObj,
      });
    }
  } else {
    // auto_execute — just log
    await logSkillActivity(workspaceId, skillId, contract.skill, summaryStr, tagRoute, detailsObj);
  }

  logger.info(`Skill ${skillId} complete [${tagRoute}]: ${summaryStr.slice(0, 80)} (${result.durationMs}ms)`);

  return {
    success: true, output: result.output, parsed, tokens: result.tokens,
    model: result.model, durationMs: result.durationMs,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildCagContext(
  workspaceId: string,
  skillId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const [category, name] = skillId.split("/");

  // ── Level 2: Workspace — Agent Identity Documents ─────────────────
  // These define WHO the agent is for this client

  let brandVoice = "";
  try {
    brandVoice = readFileSync(join(NEXAAS_ROOT, "identity", workspaceId, "brand-voice.md"), "utf-8");
  } catch { /* no brand voice yet */ }

  // Determine department from skill category
  const deptMap: Record<string, string> = {
    msp: "it", finance: "accounting", marketing: "marketing",
    hr: "hr", operations: "operations", sales: "sales", custom: "operations",
  };
  const dept = deptMap[category] ?? "operations";

  let deptOperations = "";
  try {
    deptOperations = readFileSync(join(NEXAAS_ROOT, "identity", workspaceId, `${dept}-operations.md`), "utf-8");
  } catch {
    // Try generic operations.md
    try {
      deptOperations = readFileSync(join(NEXAAS_ROOT, "identity", workspaceId, "operations.md"), "utf-8");
    } catch { /* no operations doc */ }
  }

  let agentHandbook = "";
  try {
    agentHandbook = readFileSync(join(NEXAAS_ROOT, "identity", workspaceId, "agent-handbook.md"), "utf-8");
  } catch { /* no handbook yet */ }

  // ── Level 2: Workspace — Behavioral Contract ──────────────────────

  const configPath = join(NEXAAS_ROOT, "config", "client-profile.yaml");
  let profile: Record<string, unknown> = {};
  try {
    profile = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch { /* no profile yet */ }

  // ── Level 3: Skill — SOP + Runbook ────────────────────────────────

  let skillSop = "";
  try {
    skillSop = readFileSync(join(NEXAAS_ROOT, "skills", category, name, `${name}.sop.md`), "utf-8");
  } catch { /* no SOP yet */ }

  let clientRunbook = "";
  try {
    clientRunbook = readFileSync(join(NEXAAS_ROOT, "runbooks", `${name}.runbook.md`), "utf-8");
  } catch { /* no runbook yet */ }

  // ── Level 3: Skill — Config + Rules ───────────────────────────────

  const skillConfigPath = join(NEXAAS_ROOT, "config", category, `${name}.yaml`);
  let skillConfig: Record<string, unknown> = {};
  try {
    skillConfig = yaml.load(readFileSync(skillConfigPath, "utf-8")) as Record<string, unknown>;
  } catch { /* no skill config */ }

  let customRules = "";
  try {
    customRules = readFileSync(join(NEXAAS_ROOT, "config", category, name, "rules.yaml"), "utf-8");
  } catch { /* no rules */ }

  // ── Assembled ClientContext ────────────────────────────────────────

  return {
    // Level 2 — Agent Identity (prose, injected into system prompt)
    brandVoice,
    deptOperations,
    agentHandbook,

    // Level 2 — Behavioral contract (structured)
    tenantName: profile.workspace ?? workspaceId,
    clientName: profile.workspace ?? workspaceId,
    tone: profile.tone ?? "professional",
    domain: profile.domain ?? "",
    approvalGates: profile.approval_gates ?? {},
    hardLimits: profile.hard_limits ?? [],
    escalationRules: profile.escalation_rules ?? {},

    // Level 3 — Skill procedures
    skillSop,
    clientRunbook: clientRunbook || undefined,

    // Level 3 — Skill config
    ...skillConfig,

    // Level 3 — Custom rules
    customRules: customRules || undefined,

    // Level 3 — Input data
    ...input,

    // RAG chunks (empty for now — future Qdrant integration)
    ragChunks: [],
  };
}

function buildUserPrompt(skillId: string, input: Record<string, unknown>): string {
  // Format the input as a clear request for Claude
  const parts: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) {
      parts.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
    }
  }

  if (parts.length === 0) {
    return `Execute the ${skillId} skill.`;
  }

  return `Execute the ${skillId} skill with the following parameters:\n\n${parts.join("\n")}`;
}

function parseSkillOutput(output: string): Record<string, unknown> | null {
  // Try to extract JSON from the output
  const cleaned = output.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  // Try full output as JSON
  try {
    return JSON.parse(cleaned);
  } catch { /* not pure JSON */ }

  // Try to find JSON object in the output
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* not valid JSON */ }
  }

  return { summary: cleaned.slice(0, 500) };
}

function determineTagRoute(
  parsed: Record<string, unknown> | null,
  contract: SkillContract,
): string {
  if (!parsed) return "flag";

  // Check for hard limit triggers
  if (parsed.hardLimitTriggered) return "flag";
  if (parsed.requiresHumanReview) return "flag";

  // Check contract-level approval gate
  if ((contract as any).approval_gate === "always") return "approval_required";

  // Check Claude's decision
  if (parsed.requiresApproval) return "approval_required";

  // Check if TAG defaults say this action needs approval
  const tagDefaults = contract.tag_defaults ?? {};
  if (tagDefaults.approval_required && Array.isArray(tagDefaults.approval_required)) {
    // If all actions go through approval, or specific action matches
    if (tagDefaults.approval_required.length > 0 && tagDefaults.auto_execute &&
        (tagDefaults.auto_execute as string[]).length === 0) {
      return "approval_required";
    }
  }

  return "auto_execute";
}
