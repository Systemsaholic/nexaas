/**
 * MCP Client — connects to stdio-based MCP servers on the VPS.
 *
 * Reads server configs from the workspace's .mcp.json, spawns the
 * MCP server as a child process, and provides tool listing + invocation.
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
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

    this.process.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr!.on("data", (data: Buffer) => {
      // MCP servers may log to stderr — ignore for now
    });

    this.process.on("exit", (code) => {
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server ${this.serverName} exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    // Initialize the MCP connection
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nexaas-runtime", version: "0.1.0" },
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});

    // List available tools
    const toolsResult = await this.send("tools/list", {}) as { tools: McpTool[] };
    this.tools = toolsResult.tools ?? [];
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
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      const message = JSON.stringify(request) + "\n";
      this.process!.stdin!.write(message);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.process!.stdin!.write(JSON.stringify(notification) + "\n");
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
  const { readFileSync, existsSync } = require("fs");
  const { join } = require("path");

  const mcpJsonPath = join(workspacePath, ".mcp.json");
  if (!existsSync(mcpJsonPath)) return {};

  const content = readFileSync(mcpJsonPath, "utf-8");
  const parsed = JSON.parse(content);
  return parsed.mcpServers ?? {};
}
