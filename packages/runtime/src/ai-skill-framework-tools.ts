/**
 * Framework-level tools injected into every ai-skill's agentic loop (#60).
 *
 * Unlike workspace-declared MCP servers (telegram-mcp, email-mcp, etc.),
 * these tools are handled in-process by the framework itself. They let
 * Claude explicitly produce typed outputs declared in the skill manifest
 * instead of relying on the implicit `primary_output` auto-map from
 * Stage 1b (#45).
 *
 * Currently shipped:
 *
 *   framework__produce_output({ output_id, payload })
 *     Look up output in manifest.outputs[], route via engine.apply with
 *     the declared routing_default. Multiple calls fine — each output
 *     routes independently. Return a compact receipt the AI can read to
 *     decide next actions.
 *
 * When the agentic loop ends:
 *   - If at least one produce_output fired, the primary_output
 *     auto-mapping is suppressed (explicit beats implicit).
 *   - If no produce_output fired, primary_output auto-map runs as
 *     before (Stage 1b behavior).
 *
 * Why in-process instead of an MCP server:
 *   - Zero stdio/spawn overhead per call
 *   - Direct access to the session, manifest, and engine without
 *     indirection
 *   - Framework-owned; adopters can't replace or intercept it
 *   - Keeps the tool list `framework__` prefix unambiguous
 */

import type { PalaceSession, Drawer } from "@nexaas/palace";
import type { McpTool } from "./models/agentic-loop.js";
import type { AiSkillManifest } from "./ai-skill.js";
import type { RoutingDecision } from "./tag/route.js";
import type { WorkspaceManifest } from "./schemas/workspace-manifest.js";
import { apply as applyRoutedAction } from "./engine/apply.js";

export const FRAMEWORK_TOOL_PREFIX = "framework__";

/** Reused inside ai-skill.ts to know whether to run primary_output auto-map. */
export interface FrameworkToolState {
  producedOutputs: string[];
}

export interface FrameworkToolContext {
  manifest: AiSkillManifest;
  session: PalaceSession;
  runId: string;
  stepId: string;
  workspace: string;
  workspaceManifest: WorkspaceManifest | null;
  state: FrameworkToolState;
}

/**
 * Tool definitions exposed to Claude. Shape derived from the skill manifest
 * so the description enumerates the actual declared outputs — useful for the
 * model's schema-following behavior.
 */
export function buildFrameworkTools(manifest: AiSkillManifest): McpTool[] {
  const outputs = manifest.outputs ?? [];
  if (outputs.length === 0) return [];

  const outputList = outputs
    .map((o) => `  - "${o.id}" (kind: ${o.kind ?? "unspecified"}, routing: ${o.routing_default})`)
    .join("\n");

  return [
    {
      name: `${FRAMEWORK_TOOL_PREFIX}produce_output`,
      description:
        "Produce an output declared in this skill's manifest. Call this explicitly rather than relying on primary_output auto-mapping when the skill produces multiple typed outputs in one run.\n\n" +
        "Declared outputs for this skill:\n" + outputList + "\n\n" +
        "Call as many times as needed per run — each call routes the output independently per its declared routing_default (auto_execute, approval_required, escalate, flag, defer). Returns a JSON receipt.",
      input_schema: {
        type: "object",
        required: ["output_id", "payload"],
        properties: {
          output_id: {
            type: "string",
            description: "Must match an id in the skill's outputs[] array.",
          },
          payload: {
            type: "object",
            description:
              "Output-kind-specific payload. For kind: notification → { content, parse_mode?, inline_buttons?, reply_to? }. For external_send → skill-defined fields (e.g., to, subject, body for email). The framework passes this payload through to the routing engine.",
          },
        },
      },
    },
  ];
}

export function isFrameworkTool(toolName: string): boolean {
  return toolName.startsWith(FRAMEWORK_TOOL_PREFIX);
}

/**
 * Handle a framework tool call. Throws on invalid tool name or bad input;
 * caller (the agentic loop's executeTool) catches and returns the error
 * text to Claude so the AI can correct on the next turn.
 */
export async function executeFrameworkTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FrameworkToolContext,
): Promise<string> {
  const unprefixed = toolName.slice(FRAMEWORK_TOOL_PREFIX.length);

  switch (unprefixed) {
    case "produce_output":
      return produceOutput(input, ctx);
    default:
      throw new Error(`Unknown framework tool: ${toolName}`);
  }
}

async function produceOutput(
  input: Record<string, unknown>,
  ctx: FrameworkToolContext,
): Promise<string> {
  const outputId = input.output_id;
  const payload = input.payload;

  if (typeof outputId !== "string") {
    return JSON.stringify({
      ok: false,
      error: "produce_output requires output_id: string",
    });
  }
  if (!payload || typeof payload !== "object") {
    return JSON.stringify({
      ok: false,
      error: "produce_output requires payload: object",
    });
  }

  const output = (ctx.manifest.outputs ?? []).find((o) => o.id === outputId);
  if (!output) {
    return JSON.stringify({
      ok: false,
      error: `output_id '${outputId}' not declared in manifest outputs[]`,
      available_ids: (ctx.manifest.outputs ?? []).map((o) => o.id),
    });
  }

  const routing = (output.routing_default as RoutingDecision) ?? "auto_execute";

  try {
    await applyRoutedAction(
      {
        action: {
          kind: output.id,
          payload: payload as Record<string, unknown>,
        },
        routing,
        source: `framework__produce_output:${output.id}`,
        approval: output.approval,
        notify: output.notify as { channel_role: string; timeout?: string } | undefined,
        output_kind: output.kind,
      },
      {
        session: ctx.session,
        runId: ctx.runId,
        stepId: ctx.stepId,
        workspaceManifest: ctx.workspaceManifest,
      },
    );
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `route+apply failed: ${(err as Error).message}`,
    });
  }

  ctx.state.producedOutputs.push(output.id);

  // Compact receipt — enough for the AI to decide next steps without
  // leaking internal framework state.
  const status = (() => {
    switch (routing) {
      case "auto_execute":      return "executed";
      case "approval_required": return "pending_approval";
      case "escalate":          return "escalated";
      case "flag":              return "flagged_and_executed";
      case "defer":             return "deferred";
      default:                  return "routed";
    }
  })();

  return JSON.stringify({
    ok: true,
    status,
    output_id: output.id,
    output_kind: output.kind,
    routing,
    message: status === "pending_approval"
      ? "Output created and waiting for human approval. Skill can continue producing other outputs in the same run."
      : status === "executed"
        ? "Output delivered."
        : `Output routed as '${routing}'.`,
  });
}
