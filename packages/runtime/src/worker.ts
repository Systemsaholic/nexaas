/**
 * Nexaas worker entry point — starts BullMQ worker + outbox relay + Bull Board dashboard.
 *
 * This is what the nexaas-worker systemd service runs:
 *   ExecStart=/snap/bin/node /opt/nexaas/node_modules/.bin/tsx /opt/nexaas/packages/runtime/src/worker.ts
 *
 * It starts:
 * 1. The BullMQ skill step worker (processes jobs through the pillar pipeline)
 * 2. The outbox relay (polls Postgres outbox, enqueues to BullMQ)
 * 3. Bull Board dashboard at /queues (framework-level visibility)
 * 4. Health check at /health
 */

import http from "http";
import express from "express";
import { Queue } from "bullmq";
import { startWorker } from "./bullmq/worker.js";
import { startOutboxRelay } from "./bullmq/outbox-relay.js";
import { createDashboard } from "./bullmq/dashboard.js";
import { createPool, sql } from "@nexaas/palace";
import { runCompaction } from "./tasks/closet-compaction.js";
import { reapExpiredWaitpoints, sendPendingReminders } from "./tasks/waitpoint-reaper.js";
import { runAndRecord, sendAlerts } from "./tasks/health-monitor.js";

const WORKSPACE = process.env.NEXAAS_WORKSPACE;
const CONCURRENCY = parseInt(process.env.NEXAAS_WORKER_CONCURRENCY ?? "5", 10);
const PORT = parseInt(process.env.NEXAAS_WORKER_PORT ?? "9090", 10);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

if (!WORKSPACE) {
  console.error("NEXAAS_WORKSPACE is required");
  process.exit(1);
}

async function checkPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tester = http.createServer()
      .once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use. Kill the orphan process: fuser -k ${port}/tcp`));
        } else {
          reject(err);
        }
      })
      .once("listening", () => tester.close(() => resolve()))
      .listen(port);
  });
}

async function reconcileOrphanedRuns(workspace: string): Promise<number> {
  const result = await sql<{ count: string }>(`
    WITH reconciled AS (
      UPDATE nexaas_memory.skill_runs
         SET status = 'cancelled',
             completed_at = COALESCE(completed_at, now()),
             error_summary = COALESCE(error_summary, 'reconciled at worker startup — prior worker crashed')
       WHERE workspace = $1
         AND status = 'running'
         AND last_activity < now() - interval '2 minutes'
       RETURNING 1
    )
    SELECT count(*)::text as count FROM reconciled
  `, [workspace]);
  return parseInt(result[0]?.count ?? "0", 10);
}

async function reconcileStaleRepeatables(workspace: string): Promise<number> {
  const redisOpts = REDIS_URL.startsWith("redis://")
    ? { connection: { url: REDIS_URL } }
    : { connection: { host: "localhost", port: 6379 } };

  const queue = new Queue(`nexaas-skills-${workspace}`, redisOpts);
  let fixed = 0;

  try {
    const jobs = await queue.getRepeatableJobs();
    const now = Date.now();
    const seen = new Map<string, typeof jobs[0]>();

    for (const job of jobs) {
      const baseKey = job.name;

      if (seen.has(baseKey)) {
        // Duplicate — remove the older one (#22)
        await queue.removeRepeatableByKey(job.key);
        fixed++;
        continue;
      }
      seen.set(baseKey, job);

      // Stale schedule — next tick is in the past (#23)
      if (job.next && job.next < now) {
        await queue.removeRepeatableByKey(job.key);
        if (job.pattern) {
          await queue.add(job.name, {}, {
            repeat: { pattern: job.pattern, tz: job.tz ?? undefined },
          });
        }
        fixed++;
      }
    }
  } finally {
    await queue.close();
  }

  return fixed;
}

async function main() {
  console.log(`[nexaas] Starting worker for workspace: ${WORKSPACE}`);
  console.log(`[nexaas] Concurrency: ${CONCURRENCY}, Port: ${PORT}`);

  // Fail fast if port is occupied (#19)
  try {
    await checkPort(PORT);
  } catch (err) {
    console.error(`[nexaas] FATAL: ${(err as Error).message}`);
    process.exit(1);
  }

  // Initialize Postgres pool
  createPool();
  console.log("[nexaas] Postgres pool initialized");

  // Reconcile orphaned skill_runs from prior crashes (#21)
  try {
    const reconciled = await reconcileOrphanedRuns(WORKSPACE!);
    if (reconciled > 0) {
      console.log(`[nexaas] Reconciled ${reconciled} orphaned skill_runs from prior crash`);
    }
  } catch (err) {
    console.warn("[nexaas] Orphan reconciliation failed (non-fatal):", (err as Error).message);
  }

  // Fix stale/duplicate BullMQ repeatables (#22, #23)
  try {
    const fixed = await reconcileStaleRepeatables(WORKSPACE!);
    if (fixed > 0) {
      console.log(`[nexaas] Fixed ${fixed} stale/duplicate BullMQ repeatable schedules`);
    }
  } catch (err) {
    console.warn("[nexaas] Repeatable reconciliation failed (non-fatal):", (err as Error).message);
  }

  // Start the BullMQ worker
  const worker = startWorker(WORKSPACE!, CONCURRENCY);
  console.log(`[nexaas] BullMQ worker started on queue nexaas-skills-${WORKSPACE}`);

  // Start the outbox relay
  startOutboxRelay(1000);
  console.log("[nexaas] Outbox relay started (polling every 1s)");

  // Express app for Bull Board + health check
  const app = express();

  // Bull Board dashboard — framework-level visibility
  const dashboard = createDashboard(WORKSPACE!);
  app.use("/queues", dashboard.getRouter());
  console.log("[nexaas] Bull Board dashboard at /queues");

  // PA HTTP adapter — enables client dashboard to use the full PA service
  app.use(express.json());

  app.post("/api/pa/message", async (req, res) => {
    try {
      const { handlePaMessage } = await import("./pa/service.js");

      const { message, senderName, senderId, channel, threadId, systemPrompt } = req.body;

      if (!message) {
        res.status(400).json({ error: "message required" });
        return;
      }

      // Auto-discover MCP servers from workspace .mcp.json
      const { loadMcpConfigs } = await import("./mcp/client.js");
      const wsRoot = process.env.NEXAAS_WORKSPACE_ROOT ?? "";
      const mcpConfigs = loadMcpConfigs(wsRoot);
      const availableMcpServers = Object.keys(mcpConfigs);

      const persona = {
        id: "nexmatic-ai",
        displayName: "Nexmatic AI",
        type: "human-facing" as const,
        owner: senderId ?? "dashboard",
        modelTier: "good",
        systemPrompt: systemPrompt ?? "You are a helpful AI assistant for this business.",
        mcpServers: availableMcpServers,
        palaceAccess: { read: ["*"], deny: [] },
        channels: ["dashboard"],
        maxTurns: 10,
      };

      const result = await handlePaMessage(WORKSPACE!, persona, {
        channel: channel ?? "dashboard",
        senderId: senderId ?? "dashboard-user",
        senderName: senderName ?? "User",
        content: message,
        threadId,
      });

      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Health check
  app.get("/health", (_req, res) => {
    const isRunning = worker.isRunning();
    res.status(isRunning ? 200 : 503).json({
      status: isRunning ? "healthy" : "unhealthy",
      workspace: WORKSPACE,
      concurrency: CONCURRENCY,
      uptime: process.uptime(),
    });
  });

  // Start the HTTP server with proper error handling (#19)
  const server = app.listen(PORT, () => {
    console.log(`[nexaas] Dashboard + health on :${PORT}`);
    console.log(`[nexaas]   /queues  — Bull Board (queue visibility)`);
    console.log(`[nexaas]   /health  — health check`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[nexaas] FATAL: HTTP server error: ${err.message}`);
    process.exit(1);
  });

  // Background tasks
  setInterval(async () => {
    try {
      const compacted = await runCompaction(WORKSPACE!);
      if (compacted > 0) console.log(`[nexaas] Compacted ${compacted} drawers into closets`);
    } catch (err) {
      console.error("[nexaas] Compaction error:", err);
    }
  }, 5 * 60 * 1000);

  setInterval(async () => {
    try {
      const reaped = await reapExpiredWaitpoints();
      const reminded = await sendPendingReminders();
      if (reaped > 0) console.log(`[nexaas] Reaped ${reaped} expired waitpoints`);
      if (reminded > 0) console.log(`[nexaas] Sent ${reminded} waitpoint reminders`);
    } catch (err) {
      console.error("[nexaas] Reaper error:", err);
    }
  }, 60 * 1000);

  // Health monitor — every 5 minutes, uses unified notification dispatch
  setInterval(async () => {
    try {
      const report = await runAndRecord(WORKSPACE!);
      if (report.alerts.length > 0) {
        await sendAlerts(report);
      }
      if (report.status !== "healthy") {
        console.log(`[nexaas] Health: ${report.status} (${report.alerts.length} alerts)`);
      }
    } catch (err) {
      console.error("[nexaas] Health monitor error:", err);
    }
  }, 5 * 60 * 1000);

  // Delay initial health check
  setTimeout(async () => {
    try {
      const initial = await runAndRecord(WORKSPACE!);
      console.log(`[nexaas] Initial health: ${initial.status} (${initial.metrics.skills_total} skills, ${initial.metrics.palace_drawers} drawers)`);
    } catch (err) {
      console.warn("[nexaas] Initial health check failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }, 15000);

  console.log("[nexaas] Background tasks started (compaction + waitpoint reaper + health monitor)");
  console.log("[nexaas] Worker ready. Waiting for jobs...");
}

main().catch((err) => {
  console.error("[nexaas] Fatal error:", err);
  process.exit(1);
});
