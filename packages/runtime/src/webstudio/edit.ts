/**
 * Web Studio edit driver (#148).
 *
 * Replaces the original /api/webstudio/edit's single-file-in-prompt
 * pattern with an MCP-tool-driven agentic loop. The PA picks the right
 * files via list_files/read_file, writes surgical edits via
 * write_file, and verifies via diff — same shape as Claude Code's
 * own editing loop.
 *
 * The webstudio MCP server is spawned per-request with
 * WEBSTUDIO_REPO_ROOT set to the workspace's working copy. The server
 * owns all the path-traversal and binary-write protection — this
 * driver just glues the model loop to those tools.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { existsSync } from "fs";
import { runAgenticLoop, type McpTool } from "../models/agentic-loop.js";
import { McpClient } from "../mcp/client.js";
import { runTracker } from "../run-tracker.js";

export interface WebstudioEditInput {
  instruction: string;
  senderName?: string;
  // Max turns the model gets to complete the edit. The default
  // accommodates several read_file calls + one or two write_file calls
  // + a diff — most edits land in 4–8 turns.
  maxTurns?: number;
}

export interface WebstudioEditResult {
  response: string;
  turns: number;
  toolCalls: number;
  filesWritten: string[];
  filesRead: string[];
  applied: boolean;
}

const TIER_MAP: Record<string, string> = {
  cheap: "claude-haiku-4-5-20251001",
  good: "claude-sonnet-4-6",
  better: "claude-sonnet-4-6",
  best: "claude-opus-4-6",
};

const EDIT_SYSTEM_PROMPT = (instruction: string, senderName: string) => `You are a web developer assistant editing a real project for ${senderName}. The user's instruction:

"""
${instruction}
"""

You have five tools, all scoped to the project's working copy:

  - list_files(pattern?)   Discover the project layout. Try this first.
  - read_file(path)        Read a file. ALWAYS read before writing.
  - write_file(path, content)  Apply an edit. Surgical changes only — never rewrite a file from memory.
  - grep(pattern, files?)  Find where a string lives across the project.
  - diff()                 See what you've changed so far.

Workflow:
  1. list_files (optionally with a pattern) to understand the layout.
  2. read_file the candidate files you think need to change.
  3. write_file with the minimal change that satisfies the instruction.
  4. diff to verify, then summarize what you did in your final reply.

Hard rules:
  - Read before writing. Never write_file based on guesses about a file's current content.
  - Make surgical edits. Don't rewrite an entire file when changing two lines.
  - Stay focused. Only edit files relevant to the instruction.
  - When you're done, output a short summary of the files you changed.`;

export async function runWebstudioEdit(
  workspace: string,
  repoRoot: string,
  webstudioMcpEntry: string,
  input: WebstudioEditInput,
  options?: { modelTier?: string },
): Promise<WebstudioEditResult> {
  if (!existsSync(repoRoot)) {
    throw new Error(`webstudio edit: repoRoot does not exist: ${repoRoot}`);
  }
  if (!existsSync(webstudioMcpEntry)) {
    throw new Error(`webstudio edit: mcp server entry does not exist: ${webstudioMcpEntry}`);
  }

  const runId = randomUUID();
  const modelTier = options?.modelTier ?? "good";
  const model = TIER_MAP[modelTier] ?? "claude-sonnet-4-6";
  const senderName = input.senderName ?? "user";

  await runTracker.createRun({
    runId,
    workspace,
    skillId: "webstudio/edit",
    triggerType: "http:/api/webstudio/edit",
    triggerPayload: {
      instruction_preview: input.instruction.slice(0, 200),
      sender: senderName,
    },
  });
  await runTracker.markStepStarted(runId, "webstudio-edit");

  // Spawn the webstudio MCP server pinned to this workspace's repo.
  // The server reads WEBSTUDIO_REPO_ROOT — no other channel for the
  // path, so it physically can't touch any other workspace.
  const client = new McpClient("webstudio", {
    command: process.execPath,
    args: ["--import", "tsx", webstudioMcpEntry],
    env: { WEBSTUDIO_REPO_ROOT: repoRoot },
  });

  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();

  try {
    await client.connect();

    // Prefix tool names so the model sees them under a single namespace,
    // matching the framework's standard "<server>__<tool>" convention.
    const tools: McpTool[] = client.getTools().map((t) => ({
      name: `webstudio__${t.name}`,
      description: t.description,
      input_schema: t.input_schema,
    }));

    const executeTool = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
      const parts = toolName.split("__");
      if (parts.length < 2 || parts[0] !== "webstudio") {
        throw new Error(`unknown tool: ${toolName}`);
      }
      const inner = parts.slice(1).join("__");
      // Record file activity for the response payload — handy for the
      // dashboard to surface "edited 2 files" instead of digging through
      // tool calls.
      if (inner === "read_file" && typeof args.path === "string") filesRead.add(args.path);
      if (inner === "write_file" && typeof args.path === "string") filesWritten.add(args.path);
      return await client.callTool(inner, args);
    };

    const editTimeoutMs = parseInt(process.env.NEXAAS_WEBSTUDIO_EDIT_TIMEOUT_MS ?? "180000", 10);
    const result = await Promise.race([
      runAgenticLoop({
        model,
        system: EDIT_SYSTEM_PROMPT(input.instruction, senderName),
        messages: [{ role: "user", content: input.instruction }],
        tools,
        executeTool,
        limits: { maxTurns: input.maxTurns ?? 12 },
        workspace,
        runId,
        skillId: "webstudio/edit",
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`webstudio edit timed out after ${Math.round(editTimeoutMs / 1000)}s`)),
          editTimeoutMs,
        ),
      ),
    ]);

    await runTracker.markStepCompleted(runId, "webstudio-edit");

    return {
      response: result.content,
      turns: result.turns,
      toolCalls: result.toolCalls.length,
      filesWritten: Array.from(filesWritten),
      filesRead: Array.from(filesRead),
      applied: filesWritten.size > 0,
    };
  } catch (err) {
    await runTracker.markStepFailed(runId, "webstudio-edit", (err as Error).message);
    throw err;
  } finally {
    await client.disconnect().catch(() => { /* best effort */ });
  }
}

// Resolve the webstudio MCP server entry point at boot. In production
// the framework runs from `dist/`, so prefer that; fall back to the
// source path for dev (`node --import tsx`).
export function resolveWebstudioMcpEntry(nexaasRoot: string): string {
  const distEntry = join(nexaasRoot, "mcp", "servers", "webstudio", "dist", "index.js");
  if (existsSync(distEntry)) return distEntry;
  return join(nexaasRoot, "mcp", "servers", "webstudio", "src", "index.ts");
}
