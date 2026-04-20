/**
 * MCP Client — connects to stdio-based MCP servers on the VPS.
 *
 * Reads server configs from the workspace's .mcp.json, spawns the
 * MCP server as a child process, and provides tool listing + invocation.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { McpTool } from "../models/agentic-loop.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();
  private tools: McpTool[] = [];
  private disposed = false;

  constructor(
    private serverName: string,
    private config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    const env = {
      ...process.env,
      ...this.config.env,
    };

    this.process = spawn(
      this.config.command,
      this.config.args ?? [],
      {
        cwd: this.config.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Without a listener, spawn failures (ENOENT, EACCES, etc.) emit
    // 'error' asynchronously and crash the worker via uncaughtException.
    this.process.on("error", (err) => {
      this.disposed = true;
      console.warn(`[nexaas] MCP spawn error for ${this.serverName}: ${err.message}`);
      this.rejectAllPending(new Error(`MCP spawn error: ${err.message}`));
    });

    this.process.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr!.on("data", (_data: Buffer) => {
      // MCP servers may log to stderr — ignore for now
    });

    this.process.on("exit", (code, signal) => {
      this.disposed = true;
      const reason = signal ? `signal=${signal}` : `code=${code}`;
      this.rejectAllPending(new Error(`MCP server ${this.serverName} exited (${reason})`));
    });

    try {
      // Initialize the MCP connection
      await this.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "nexaas-runtime", version: "0.1.0" },
      });

      // Send initialized notification
      this.sendNotification("notifications/initialized", {});

      // List available tools and normalize schema field names
      const toolsResult = await this.send("tools/list", {}) as {
        tools: Array<{
          name: string;
          description: string;
          inputSchema?: Record<string, unknown>;
          input_schema?: Record<string, unknown>;
        }>;
      };

      this.tools = (toolsResult.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema ?? t.input_schema ?? { type: "object", properties: {} },
      }));
    } catch (err) {
      // Abort the partial connection so we don't leave a child running.
      await this.disconnect().catch(() => { /* best effort */ });
      throw err;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      try { pending.reject(err); } catch { /* ignore */ }
    }
    this.pendingRequests.clear();
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.send("tools/call", { name, arguments: args }) as {
      content: Array<{ type: string; text?: string }>;
    };

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
    }

    return JSON.stringify(result);
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    const proc = this.process;
    this.process = null;
    if (!proc || proc.killed || proc.exitCode !== null) return;

    // SIGTERM, wait up to 3s, then SIGKILL if still alive. Prevents
    // zombie MCP servers from piling up when a worker shuts down while
    // children are misbehaving.
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }

    await new Promise<void>((resolve) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      proc.once("exit", onExit);
      const timer = setTimeout(() => {
        proc.removeListener("exit", onExit);
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        resolve();
      }, 3_000);
    });

    // Reject any lingering pending requests so callers unblock instead
    // of waiting for 30s MCP request timeout.
    this.rejectAllPending(new Error(`MCP client ${this.serverName} disconnected`));
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || !this.process || this.process.exitCode !== null) {
      throw new Error(`MCP client ${this.serverName} is not connected`);
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      const message = JSON.stringify(request) + "\n";
      try {
        this.process!.stdin!.write(message);
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error(`MCP stdin write failed: ${(err as Error).message}`));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.disposed || !this.process || this.process.exitCode !== null) return;
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    try { this.process.stdin!.write(JSON.stringify(notification) + "\n"); } catch { /* ignore */ }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Not valid JSON — ignore
      }
    }
  }
}

/**
 * Load MCP server configs from a workspace's .mcp.json
 */
export function loadMcpConfigs(workspacePath: string): Record<string, McpServerConfig> {
  const mcpJsonPath = join(workspacePath, ".mcp.json");
  if (!existsSync(mcpJsonPath)) return {};

  const content = readFileSync(mcpJsonPath, "utf-8");
  const parsed = JSON.parse(content);
  return parsed.mcpServers ?? {};
}
