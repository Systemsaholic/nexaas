/**
 * MCP Client — connects to MCP servers on the VPS.
 *
 * Two transports are supported:
 *
 *   - **stdio** (default): spawn the MCP server as a child process and
 *     speak hand-rolled JSON-RPC over the pipes. Original implementation;
 *     used by every shipping server today.
 *
 *   - **streamable-http** (#143): connect to a hosted MCP endpoint over
 *     HTTP POST + SSE using the official MCP SDK's transport. Unblocks
 *     hosted services like Zernio that ship a remote endpoint instead of
 *     a local stdio binary.
 *
 * Server configs come from the workspace's .mcp.json. The shape is
 * discriminated by the presence of `transport`:
 *
 *   { "command": "uvx", "args": ["zernio-mcp"], "env": { ... } }              // stdio
 *   { "transport": "streamable-http", "url": "https://...", "headers": {} }   // http
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { Client as SdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpTool } from "../models/agentic-loop.js";

export type StdioMcpServerConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type HttpMcpServerConfig = {
  transport: "streamable-http" | "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export function isHttpConfig(config: McpServerConfig): config is HttpMcpServerConfig {
  return (config as HttpMcpServerConfig).transport === "streamable-http"
      || (config as HttpMcpServerConfig).transport === "http";
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

// Shape of a tool result returned by either transport — both speak the
// same MCP wire format, so callers see the same structure regardless.
interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class McpClient {
  // stdio state
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  // http state
  private sdkClient: SdkClient | null = null;
  private sdkTransport: StreamableHTTPClientTransport | null = null;

  private tools: McpTool[] = [];
  private disposed = false;

  constructor(
    private serverName: string,
    private config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    if (isHttpConfig(this.config)) {
      await this.connectHttp(this.config);
    } else {
      await this.connectStdio(this.config);
    }
  }

  private async connectStdio(config: StdioMcpServerConfig): Promise<void> {
    const env = {
      ...process.env,
      ...config.env,
    };

    this.process = spawn(
      config.command,
      config.args ?? [],
      {
        cwd: config.cwd,
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
      await this.sendStdio("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "nexaas-runtime", version: "0.1.0" },
      });

      // Send initialized notification
      this.sendNotificationStdio("notifications/initialized", {});

      // List available tools and normalize schema field names
      const toolsResult = await this.sendStdio("tools/list", {}) as {
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

  private async connectHttp(config: HttpMcpServerConfig): Promise<void> {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error(`MCP server ${this.serverName}: invalid url '${config.url}'`);
    }

    this.sdkTransport = new StreamableHTTPClientTransport(url, {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });

    // Mirror stdio: any error after construction must flip `disposed` so
    // the pool's isHealthy() probe drops the client instead of reusing it.
    this.sdkTransport.onerror = (err) => {
      this.disposed = true;
      console.warn(`[nexaas] MCP HTTP transport error for ${this.serverName}: ${err.message}`);
    };
    this.sdkTransport.onclose = () => {
      this.disposed = true;
    };

    this.sdkClient = new SdkClient(
      { name: "nexaas-runtime", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await this.sdkClient.connect(this.sdkTransport);

      const toolsResult = await this.sdkClient.listTools();
      this.tools = (toolsResult.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    } catch (err) {
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

  getServerName(): string {
    return this.serverName;
  }

  // Used by the pool (#63) to decide whether to reuse a cached client or
  // respawn. `disposed` flips on transport failure (stdio: spawn error,
  // stdin write failure, child exit; http: transport onerror/onclose) —
  // any of those means the connection is no longer usable even if it
  // hasn't been explicitly disconnected.
  isHealthy(): boolean {
    if (this.disposed) return false;
    if (isHttpConfig(this.config)) {
      return this.sdkClient !== null;
    }
    if (!this.process) return false;
    if (this.process.killed) return false;
    if (this.process.exitCode !== null) return false;
    return true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.invokeTool(name, args);
    const text = extractText(result);

    // MCP protocol: `isError: true` at the tool-result level signals the
    // tool itself failed (Pydantic validation, runtime error, etc.). Before
    // #48 we returned the error text as if it were normal output, which
    // let notification-dispatcher mark failed sends as `delivered`. Throw
    // so every caller's existing try/catch treats it as an error — matches
    // Node convention (throw, don't silently return the error text).
    if (result.isError === true) {
      const err = new Error(`MCP tool '${name}' returned isError: ${text || "(no message)"}`);
      (err as Error & { mcpIsError?: boolean }).mcpIsError = true;
      throw err;
    }

    return text;
  }

  /**
   * Raw tool invocation that returns the full structured result (including
   * `isError`) without throwing. Use when you need to inspect the error
   * text for branching logic. The regular `callTool` is the right default.
   */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError: boolean;
    text: string;
  }> {
    const result = await this.invokeTool(name, args);
    const text = extractText(result);
    return { content: result.content ?? [], isError: result.isError === true, text };
  }

  private async invokeTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (this.sdkClient) {
      // SDK's callTool returns a union — the CallToolResult variant has
      // `content` + `isError`, the legacy `toolResult` variant doesn't.
      // We only support the modern shape; servers using the legacy shape
      // are extremely rare and would have failed under the old stdio code
      // too.
      const result = await this.sdkClient.callTool({ name, arguments: args }) as ToolCallResult;
      return result;
    }
    return await this.sendStdio("tools/call", { name, arguments: args }) as ToolCallResult;
  }

  async disconnect(): Promise<void> {
    this.disposed = true;

    if (this.sdkClient || this.sdkTransport) {
      const client = this.sdkClient;
      const transport = this.sdkTransport;
      this.sdkClient = null;
      this.sdkTransport = null;
      try {
        if (client) await client.close();
        else if (transport) await transport.close();
      } catch { /* best effort */ }
      this.rejectAllPending(new Error(`MCP client ${this.serverName} disconnected`));
      return;
    }

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

  private async sendStdio(method: string, params: Record<string, unknown>): Promise<unknown> {
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

  private sendNotificationStdio(method: string, params: Record<string, unknown>): void {
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

function extractText(result: ToolCallResult): string {
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }
  return JSON.stringify(result);
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
