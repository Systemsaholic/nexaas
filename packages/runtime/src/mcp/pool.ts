/**
 * MCP client pool (#63) — reuse long-lived subprocesses across ai-skill runs.
 *
 * Problem: every call site currently does
 *     new McpClient → connect → work → disconnect
 * which costs 3–5s per run for a skill declaring many MCPs (14 subprocess
 * spawns + initialize + tools/list + SIGTERM × 14 at the end).
 *
 * Pool semantics:
 *   - acquire(name, config): returns a healthy, already-connected client.
 *     First call spawns the subprocess; subsequent calls for the same
 *     serverName return the cached client. If the cached client is
 *     unhealthy (subprocess exited / crashed), we discard it and respawn.
 *   - release(client): no-op. The client stays in the pool until shutdown
 *     or until the subprocess dies.
 *   - shutdown(): disconnect every pooled client. Called from the BullMQ
 *     worker's SIGTERM handler.
 *
 * Opt-in via NEXAAS_MCP_POOL_ENABLED. When disabled, acquireMcpClient /
 * releaseMcpClient fall through to the legacy spawn-per-run behavior —
 * transparent to every call site.
 *
 * Scope for this change: ai-skill.ts only (the hottest path). Other call
 * sites (subagent, notification-dispatcher, pa/service) keep spawn-per-run
 * until pooling is battle-tested.
 *
 * Deliberately out of scope: age-based cycling, per-skill opt-out, config
 * reload without worker restart. Those can land after we see it behave.
 */

import { McpClient } from "./client.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export function isPoolEnabled(): boolean {
  return process.env.NEXAAS_MCP_POOL_ENABLED === "true"
      || process.env.NEXAAS_MCP_POOL_ENABLED === "1";
}

class McpClientPool {
  private clients = new Map<string, McpClient>();
  // Serialize concurrent acquire() calls for the same serverName so we
  // don't spawn two subprocesses racing to populate the slot.
  private pending = new Map<string, Promise<McpClient>>();

  async acquire(serverName: string, config: McpServerConfig): Promise<McpClient> {
    const existing = this.clients.get(serverName);
    if (existing && existing.isHealthy()) {
      return existing;
    }

    // Unhealthy cached client — drop the reference. Old subprocess may
    // already be gone; the stale client's disconnect() is a no-op in that
    // case. Best-effort cleanup either way.
    if (existing) {
      this.clients.delete(serverName);
      void existing.disconnect().catch(() => { /* best effort */ });
    }

    // Coalesce concurrent acquires: if another caller is already spawning
    // this server, wait for their result instead of spawning again.
    const inflight = this.pending.get(serverName);
    if (inflight) return inflight;

    const spawn = (async () => {
      const client = new McpClient(serverName, config);
      try {
        await client.connect();
        this.clients.set(serverName, client);
        return client;
      } finally {
        this.pending.delete(serverName);
      }
    })();
    this.pending.set(serverName, spawn);
    return spawn;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  release(_client: McpClient): void {
    // Intentional no-op. Clients stay in the pool; their lifetime matches
    // the worker's. Exists so call sites can be symmetric with the
    // non-pooled path (which calls disconnect in finally).
  }

  async shutdown(): Promise<void> {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    this.pending.clear();
    await Promise.all(
      clients.map((c) => c.disconnect().catch(() => { /* best effort */ })),
    );
  }

  size(): number {
    return this.clients.size;
  }
}

const _pool = new McpClientPool();

/**
 * Acquire an MCP client. When pooling is enabled, returns a reused
 * long-lived client. When disabled, spawns a fresh subprocess per call
 * (legacy behavior). Callers must pair each acquire with release() in
 * a finally block.
 */
export async function acquireMcpClient(
  serverName: string,
  config: McpServerConfig,
): Promise<McpClient> {
  if (isPoolEnabled()) {
    return _pool.acquire(serverName, config);
  }
  const client = new McpClient(serverName, config);
  await client.connect();
  return client;
}

/**
 * Release an MCP client. No-op when pooling is enabled (client stays in
 * the pool); disconnects the subprocess when pooling is disabled.
 */
export async function releaseMcpClient(client: McpClient): Promise<void> {
  if (isPoolEnabled()) {
    _pool.release(client);
    return;
  }
  await client.disconnect();
}

/**
 * Shut down every pooled client. Safe to call whether or not pooling was
 * ever enabled — the pool is just empty in the off case.
 */
export async function shutdownMcpPool(): Promise<void> {
  await _pool.shutdown();
}

/**
 * Diagnostic — exposed for the worker's /health endpoint and tests.
 */
export function mcpPoolSize(): number {
  return _pool.size();
}
