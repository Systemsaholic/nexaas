/**
 * Claude Code CLI wrapper for Trigger.dev tasks.
 *
 * Spawns `claude --print --output-format stream-json` as a subprocess,
 * pipes the prompt via stdin, and collects the structured JSON output.
 *
 * Mirrors the pattern in nexaas-framework/engine/orchestrator/session_manager.py.
 *
 * Generalized from Phoenix Voyages for multi-workspace use:
 * - WORKSPACE_ROOT is configurable via env or per-call option
 * - MCP config path is configurable and cache is keyed by path
 * - Agent root is configurable per-call
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { parse as parseYaml } from "./yaml-lite.js";
import { logger } from "@trigger.dev/sdk/v3";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ClaudeOptions {
  /** Agent name (maps to agents/<name>/config.yaml for system prompt) */
  agent?: string;
  /** Direct prompt to send */
  prompt: string;
  /** Working directory (defaults to workspace root) */
  cwd?: string;
  /** Max timeout in ms (default: 5 minutes) */
  timeoutMs?: number;
  /** Model override (e.g., "sonnet", "haiku", "opus") */
  model?: string;
  /**
   * MCP server names to load (from project .mcp.json).
   * When specified, uses --strict-mcp-config to ONLY load these servers,
   * preventing the full 730-tool context from exceeding Haiku's window.
   * When omitted, loads all project MCP servers (only safe for large-context models).
   */
  mcpServers?: string[];
  /** Override workspace root for this call */
  workspaceRoot?: string;
}

export interface ClaudeResult {
  /** Final text output from Claude */
  output: string;
  /** Token usage */
  tokens: { input: number; output: number };
  /** Model used */
  model: string;
  /** Whether the run completed successfully */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  content?: string;
  // message is a full Message object {role, content: [{type, text}...]}, not a string
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }> | string;
  };
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  // Content block fields
  content_block?: {
    type: string;
    text?: string;
  };
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || process.env.NEXAAS_ROOT || "/opt/nexaas";
const CLAUDE_BIN = process.env.CLAUDE_CODE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── MCP config builder ──────────────────────────────────────────────────────

const _mcpConfigCache = new Map<string, Record<string, unknown>>();

function loadProjectMcpConfig(mcpConfigPath?: string): Record<string, unknown> {
  const configPath = mcpConfigPath || join(DEFAULT_WORKSPACE_ROOT, ".mcp.json");
  const cached = _mcpConfigCache.get(configPath);
  if (cached) return cached;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const servers = parsed.mcpServers || {};
    _mcpConfigCache.set(configPath, servers);
    return servers;
  } catch {
    const empty: Record<string, unknown> = {};
    _mcpConfigCache.set(configPath, empty);
    return empty;
  }
}

/**
 * Build a minimal MCP config JSON containing only the requested servers.
 * Returns null if no servers requested or none found.
 */
function buildMcpConfig(serverNames: string[], mcpConfigPath?: string): string | null {
  const allServers = loadProjectMcpConfig(mcpConfigPath);
  const subset: Record<string, unknown> = {};
  for (const name of serverNames) {
    if (allServers[name]) {
      subset[name] = allServers[name];
    } else {
      logger.warn(`MCP server "${name}" not found in .mcp.json`);
    }
  }
  if (Object.keys(subset).length === 0) return null;
  return JSON.stringify({ mcpServers: subset });
}

// ── Agent config loader ─────────────────────────────────────────────────────

function loadAgentSystemPrompt(agentName: string, agentRoot?: string): string | null {
  const resolvedAgentRoot = agentRoot || join(DEFAULT_WORKSPACE_ROOT, "agents");

  // Resolve agent path — handles multiple naming conventions:
  //   "pa-al"                    → agents/pa/sub-agents/al/prompt.md
  //   "pa"                       → agents/pa/prompt.md
  //   "crm/segmentation"         → agents/crm/sub-agents/segmentation/prompt.md
  //   "operations/monitor"       → agents/operations/sub-agents/monitor/prompt.md
  //   "social-inbox/comment-responder" → agents/social-inbox/sub-agents/comment-responder/prompt.md
  //   "marketing/email/cruise"   → agents/marketing/sub-agents/email/sub-agents/cruise/prompt.md
  let promptPath: string | null = null;

  // Strategy 1: Slash-separated path (e.g., "crm/segmentation", "marketing/email/cruise")
  if (agentName.includes("/")) {
    const slashParts = agentName.split("/");

    // Two-level: "parent/child" → agents/<parent>/sub-agents/<child>/prompt.md
    if (slashParts.length === 2) {
      const subPath = resolve(
        resolvedAgentRoot,
        slashParts[0],
        "sub-agents",
        slashParts[1],
        "prompt.md"
      );
      if (existsSync(subPath)) {
        promptPath = subPath;
      }
    }

    // Three-level: "parent/mid/child" → agents/<parent>/sub-agents/<mid>/sub-agents/<child>/prompt.md
    if (!promptPath && slashParts.length === 3) {
      const deepPath = resolve(
        resolvedAgentRoot,
        slashParts[0],
        "sub-agents",
        slashParts[1],
        "sub-agents",
        slashParts[2],
        "prompt.md"
      );
      if (existsSync(deepPath)) {
        promptPath = deepPath;
      }
    }

    // Fall back to top-level of the first segment
    if (!promptPath) {
      const topPath = resolve(resolvedAgentRoot, slashParts[0], "prompt.md");
      if (existsSync(topPath)) {
        promptPath = topPath;
      }
    }
  }

  // Strategy 2: Dash-separated (e.g., "pa-al" → agents/pa/sub-agents/al/)
  if (!promptPath) {
    const parts = agentName.split("-");
    if (parts.length >= 2) {
      const parent = parts[0];
      const child = parts.slice(1).join("-");
      const subPath = resolve(
        resolvedAgentRoot,
        parent,
        "sub-agents",
        child,
        "prompt.md"
      );
      if (existsSync(subPath)) {
        promptPath = subPath;
      }
    }
  }

  // Strategy 3: Direct top-level (e.g., "email-sorting" → agents/email-sorting/)
  if (!promptPath) {
    const topPath = resolve(resolvedAgentRoot, agentName, "prompt.md");
    if (existsSync(topPath)) {
      promptPath = topPath;
    }
  }

  if (!promptPath) {
    return null;
  }

  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    return null;
  }
}

// ── Main runner ─────────────────────────────────────────────────────────────

export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const startTime = Date.now();
  const workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const cwd = options.cwd || workspaceRoot;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Build command args
  const args: string[] = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  // Restrict MCP servers to only those needed for this task.
  // Without this, all 38 project MCP servers (730+ tools) are loaded,
  // which exceeds Haiku/Sonnet's 200K context window.
  const mcpConfigPath = join(workspaceRoot, ".mcp.json");
  if (options.mcpServers && options.mcpServers.length > 0) {
    const mcpConfig = buildMcpConfig(options.mcpServers, mcpConfigPath);
    if (mcpConfig) {
      args.push("--strict-mcp-config", "--mcp-config", mcpConfig);
      logger.info(`Restricted MCP to: ${options.mcpServers.join(", ")}`);
    }
  } else {
    // No MCP servers specified — load none to avoid context overflow.
    // Tasks that need MCP tools MUST specify mcpServers.
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    logger.info("No mcpServers specified — running with no MCP tools");
  }

  // Load agent system prompt if specified
  if (options.agent) {
    const agentRoot = join(workspaceRoot, "agents");
    const systemPrompt = loadAgentSystemPrompt(options.agent, agentRoot);
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
      logger.info(`Loaded system prompt for agent: ${options.agent}`);
    } else {
      logger.warn(`No prompt.md found for agent: ${options.agent}`);
    }
  }

  logger.info(`Spawning Claude Code`, {
    agent: options.agent || "default",
    cwd,
    promptLength: options.prompt.length,
  });

  return new Promise<ClaudeResult>((resolve) => {
    // Strip Claude nesting detection env vars so spawned Claude doesn't
    // think it's inside another session (happens when worker is started
    // from a Claude Code terminal)
    const cleanEnv: Record<string, string | undefined> = { ...process.env, TERM: "dumb" };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv,
      detached: true, // New process group so we can kill the entire tree
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Send prompt via stdin and close
    proc.stdin.write(options.prompt);
    proc.stdin.end();

    // Kill entire process group (negative PID) to clean up subprocesses
    const killProcessGroup = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        // Process group may already be gone
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    };

    // Timeout guard — kills entire process tree, not just direct child
    const timer = setTimeout(() => {
      logger.warn(`Claude Code timed out after ${timeoutMs}ms, killing process group`);
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null) killProcessGroup("SIGKILL");
      }, 5000);
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (code !== 0) {
        // Try to extract error from stream-json stdout (Claude Code reports
        // "Prompt is too long" and other API errors via stdout with is_error=true)
        const streamResult = parseStreamOutput(stdout);
        const stderrClean = stderr.trim().slice(0, 500);
        const stdoutError = (streamResult.output || "").slice(0, 500);
        const isTimeout = code === 143 || code === 137; // SIGTERM=143, SIGKILL=137
        const errorMsg = isTimeout
          ? `Timed out after ${Math.round(timeoutMs / 1000)}s (exit ${code})`
          : stderrClean || stdoutError || `Process exited with code ${code}`;

        logger.error(`Claude Code exited with code ${code}`, {
          stderr: stderrClean,
          stdoutError: stdoutError.slice(0, 200),
        });
        resolve({
          output: "",
          tokens: streamResult.tokens,
          model: streamResult.model,
          success: false,
          durationMs,
          error: String(errorMsg),
        });
        return;
      }

      // Parse stream-json output: each line is a JSON message
      const result = parseStreamOutput(stdout);
      logger.info(`Claude Code completed`, {
        durationMs,
        tokens: result.tokens,
        model: result.model,
        outputLength: result.output.length,
      });

      resolve({
        ...result,
        success: true,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: "",
        tokens: { input: 0, output: 0 },
        model: "unknown",
        success: false,
        durationMs: Date.now() - startTime,
        error: `Failed to spawn: ${err.message}`,
      });
    });
  });
}

// ── Stream JSON parser ──────────────────────────────────────────────────────

function parseStreamOutput(raw: string): Omit<ClaudeResult, "success" | "durationMs" | "error"> {
  const lines = raw.split("\n").filter((l) => l.trim());
  let output = "";
  let model = "unknown";
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    try {
      const msg: StreamMessage = JSON.parse(line);

      // Collect text from assistant messages
      // msg.message is a Message object {content: [{type, text}...]}, not a string
      if (msg.type === "assistant" && msg.message) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === "text" && block.text) output += block.text;
          }
        } else if (typeof content === "string") {
          output += content;
        }
      }

      // Content block text
      if (msg.type === "content_block_delta" || msg.type === "content_block_stop") {
        if (msg.content_block?.text) {
          output += msg.content_block.text;
        }
      }

      // Result message (final output)
      if (msg.type === "result" && msg.result) {
        output = msg.result;
      }

      // Usage tracking
      if (msg.usage) {
        if (msg.usage.input_tokens) inputTokens += msg.usage.input_tokens;
        if (msg.usage.output_tokens) outputTokens += msg.usage.output_tokens;
      }

      // Model info
      if (msg.model) {
        model = msg.model;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return {
    output: output.trim(),
    tokens: { input: inputTokens, output: outputTokens },
    model,
  };
}
