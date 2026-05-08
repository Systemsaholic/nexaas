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
import { appendWal } from "@nexaas/palace";
import type { McpTool } from "./models/agentic-loop.js";
import type { AiSkillManifest } from "./ai-skill.js";
import type { RoutingDecision } from "./tag/route.js";
import type { WorkspaceManifest } from "./schemas/workspace-manifest.js";
import { apply as applyRoutedAction } from "./engine/apply.js";
import {
  registerWaitpoint,
  getWaitpointStatus,
  cancelWaitpoint,
} from "./tasks/inbound-match-waitpoint.js";

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
  const tools: McpTool[] = [];

  const outputs = manifest.outputs ?? [];
  if (outputs.length > 0) {
    const outputList = outputs
      .map((o) => `  - "${o.id}" (kind: ${o.kind ?? "unspecified"}, routing: ${o.routing_default})`)
      .join("\n");

    tools.push({
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
    });
  }

  // request_match is universally useful — ship unconditionally, not gated
  // on outputs[]. Skills that don't need pattern-matched inbound capture
  // simply don't call it.
  tools.push({
    name: `${FRAMEWORK_TOOL_PREFIX}request_match`,
    description:
      "Register an inbound-match waitpoint and block until an inbound drawer " +
      "matches, or timeout. Use for OAuth callback codes, 2FA delivery, one-time " +
      "confirmation messages, or any \"wait for a pattern-matched user message\" " +
      "flow. Channel-agnostic — matches on any inbox.messaging.* drawer written " +
      "through a configured channel binding.\n\n" +
      "Named patterns: digit_code | hex_token | url | uuid_v4 | any. Raw regex " +
      "allowed via content_regex + raw: true (safety-checked at registration).\n\n" +
      "Returns { ok, status, content } on match, { ok: false, status: \"timeout\" | \"cancelled\" | \"expired\", error } on failure. Safe to call multiple times in one run.",
    input_schema: {
      type: "object",
      required: ["channel_role"],
      properties: {
        channel_role: {
          type: "string",
          description: "Framework channel_role to watch — the inbox.messaging.<role> room adapter writes to. Must be declared in workspace manifest's channel_bindings.",
        },
        content_pattern: {
          type: "string",
          enum: ["digit_code", "hex_token", "url", "uuid_v4", "any"],
          description: "Named pattern; pick the closest fit. For 2FA codes: digit_code. For OAuth redirect URLs: url. Use content_regex + raw: true for custom patterns.",
        },
        content_regex: {
          type: "string",
          description: "Custom regex; requires raw: true. Avoid nested quantifiers (framework rejects backtrack-prone patterns).",
        },
        raw: {
          type: "boolean",
          description: "Must be true to use content_regex.",
        },
        sender_id: {
          type: "string",
          description: "Optional: restrict to drawers where from.id or from (string) matches. Security-important for 2FA — prevents other users' messages from accidentally resolving your waitpoint.",
        },
        timeout_seconds: {
          type: "number",
          description: "Default 300 (5 min). Max 86400. The tool call blocks until match, timeout, or cancellation.",
        },
        extract: {
          type: "string",
          enum: ["first_regex_match", "first_capture_group", "full_content"],
          description: "What to return as resolved_with.content. Default first_regex_match.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional adopter-defined tags (e.g., [\"2fa\"], [\"oauth\"]) surfaced to dashboards/UIs for rendering hints. Framework has no semantics for these — they're passthrough metadata. Useful when a workspace dashboard wants to render a styled input (\"Enter the code your bank sent\") instead of a generic reply box.",
        },
      },
    },
  });

  return tools;
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
    case "request_match":
      return requestMatch(input, ctx);
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

  // Single source of truth for output-cadence tracking (#86 Gap 1). The
  // staleness watchdog reads MAX(created_at) on this op per (skill_id,
  // output_id) to decide whether a declared output has gone silent
  // longer than the manifest's staleness_alert.max_silence permits.
  // Best-effort; observability never blocks the produce-output path.
  try {
    await appendWal({
      workspace: ctx.workspace,
      op: "output_produced",
      actor: `skill:${ctx.manifest.id}`,
      payload: {
        skill_id: ctx.manifest.id,
        skill_version: ctx.manifest.version,
        output_id: output.id,
        output_kind: output.kind ?? null,
        routing,
        run_id: ctx.runId,
        step_id: ctx.stepId,
      },
    });
  } catch (err) {
    console.error("[nexaas] output_produced WAL emit failed:", err);
  }

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

const REQUEST_MATCH_POLL_MS = 1500;
const REQUEST_MATCH_MIN_TIMEOUT_SECONDS = 5;
const REQUEST_MATCH_MAX_TIMEOUT_SECONDS = 24 * 3600;

async function requestMatch(
  input: Record<string, unknown>,
  ctx: FrameworkToolContext,
): Promise<string> {
  const channelRole = input.channel_role;
  if (typeof channelRole !== "string" || !channelRole) {
    return JSON.stringify({ ok: false, error: "request_match requires channel_role: string" });
  }

  const timeoutSeconds = (() => {
    const raw = input.timeout_seconds;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 300;
    return Math.min(REQUEST_MATCH_MAX_TIMEOUT_SECONDS, Math.max(REQUEST_MATCH_MIN_TIMEOUT_SECONDS, raw));
  })();

  // Pass-through params to registerWaitpoint, letting its own validation
  // handle named-vs-raw-vs-missing decisions.
  const reg = await registerWaitpoint({
    workspace: ctx.workspace,
    match: {
      room_pattern: channelRole,
      content_pattern: input.content_pattern as string | undefined,
      content_regex: input.content_regex as string | undefined,
      raw: input.raw === true,
      sender_id: typeof input.sender_id === "string" ? input.sender_id : undefined,
    },
    timeout_seconds: timeoutSeconds,
    extract: (input.extract as "first_regex_match" | "first_capture_group" | "full_content" | undefined) ?? "first_regex_match",
    tags: Array.isArray(input.tags) ? (input.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
  });

  if ("error" in reg) {
    return JSON.stringify({ ok: false, error: reg.error });
  }

  const waitpointId = reg.waitpoint_id;
  const deadline = Date.now() + timeoutSeconds * 1000;

  // Poll until resolved, expired, cancelled, or we hit the deadline.
  // Inbound-dispatcher resolves waitpoints on drawer arrival (every ~3s);
  // our poll catches the resolution shortly after.
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, REQUEST_MATCH_POLL_MS));

    const status = await getWaitpointStatus(ctx.workspace, waitpointId);
    if (!status) {
      // Waitpoint record gone entirely — shouldn't happen but don't spin.
      return JSON.stringify({ ok: false, status: "missing", error: "waitpoint record not found", waitpoint_id: waitpointId });
    }

    if (status.status === "resolved") {
      return JSON.stringify({
        ok: true,
        status: "resolved",
        content: status.resolved_with?.content ?? "",
        drawer_id: status.resolved_with?.drawer_id,
        matched_at: status.resolved_with?.matched_at,
        waitpoint_id: waitpointId,
      });
    }

    if (status.status === "expired" || status.status === "cancelled") {
      return JSON.stringify({
        ok: false,
        status: status.status,
        error: `Waitpoint ${status.status}`,
        waitpoint_id: waitpointId,
      });
    }
    // Still pending — continue polling.
  }

  // Deadline hit — race one final status check before returning timeout.
  // If the inbound landed in the last poll-interval, we want to capture it.
  const finalStatus = await getWaitpointStatus(ctx.workspace, waitpointId);
  if (finalStatus?.status === "resolved") {
    return JSON.stringify({
      ok: true,
      status: "resolved",
      content: finalStatus.resolved_with?.content ?? "",
      drawer_id: finalStatus.resolved_with?.drawer_id,
      matched_at: finalStatus.resolved_with?.matched_at,
      waitpoint_id: waitpointId,
    });
  }

  // Best-effort cleanup — cancel the waitpoint so it doesn't hang around.
  try { await cancelWaitpoint(ctx.workspace, waitpointId); } catch { /* ignore */ }

  return JSON.stringify({
    ok: false,
    status: "timeout",
    error: `Waitpoint timed out after ${timeoutSeconds}s`,
    waitpoint_id: waitpointId,
  });
}
