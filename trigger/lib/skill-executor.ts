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

import { logger } from "@trigger.dev/sdk/v3";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { runClaude, type ClaudeResult } from "./claude.js";
import { renderTemplate } from "./template-renderer.js";
import { logSkillActivity, logSkillTokenUsage } from "./skill-logger.js";

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

  // 2. Render system prompt from template
  let systemPrompt = "";
  const templatePath = join(skillDir, "system-prompt.hbs");
  if (existsSync(templatePath)) {
    // Build CAG context from workspace data
    const cagContext = buildCagContext(workspaceId, skillId, input);
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

  // 8. Log to activity_log
  await logSkillActivity(
    workspaceId,
    skillId,
    contract.skill,
    typeof summary === "string" ? summary : String(summary),
    tagRoute,
    { ...parsed, tokens_used: result.tokens.input + result.tokens.output },
  );

  // 9. Log token usage
  await logSkillTokenUsage(
    workspaceId,
    skillId,
    result.model,
    result.tokens.input,
    result.tokens.output,
  );

  logger.info(`Skill ${skillId} complete: ${typeof summary === "string" ? summary.slice(0, 80) : "done"} (${result.durationMs}ms)`);

  return {
    success: true,
    output: result.output,
    parsed,
    tokens: result.tokens,
    model: result.model,
    durationMs: result.durationMs,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildCagContext(
  workspaceId: string,
  skillId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // Layer 1: Behavioral contract from workspace config
  const configPath = join(NEXAAS_ROOT, "config", "client-profile.yaml");
  let profile: Record<string, unknown> = {};
  try {
    profile = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch { /* no profile yet */ }

  // Layer 1b: Skill-specific config
  const [category, name] = skillId.split("/");
  const skillConfigPath = join(NEXAAS_ROOT, "config", category, `${name}.yaml`);
  let skillConfig: Record<string, unknown> = {};
  try {
    skillConfig = yaml.load(readFileSync(skillConfigPath, "utf-8")) as Record<string, unknown>;
  } catch { /* no skill config */ }

  // Layer 1c: Custom rules
  const rulesPath = join(NEXAAS_ROOT, "config", category, name, "rules.yaml");
  let customRules = "";
  try {
    customRules = readFileSync(rulesPath, "utf-8");
  } catch { /* no rules */ }

  return {
    // From profile
    tenantName: profile.workspace ?? workspaceId,
    tone: profile.tone ?? "professional",
    domain: profile.domain ?? "",
    approvalGates: profile.approval_gates ?? {},
    hardLimits: profile.hard_limits ?? [],
    escalationRules: profile.escalation_rules ?? {},

    // From skill config
    ...skillConfig,

    // Custom rules
    customRules: customRules || undefined,

    // Input data
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
  if (parsed.requiresApproval) return "approval_required";

  // Default to auto_execute for successful runs
  return "auto_execute";
}
