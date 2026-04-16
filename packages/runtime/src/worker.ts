/**
 * Nexaas worker entry point — starts BullMQ worker + outbox relay + Bull Board dashboard.
 *
 * This is what the nexaas-worker systemd service runs:
 *   ExecStart=/usr/bin/node packages/runtime/src/worker.js
 *
 * It starts:
 * 1. The BullMQ skill step worker (processes jobs through the pillar pipeline)
 * 2. The outbox relay (polls Postgres outbox, enqueues to BullMQ)
 * 3. Bull Board dashboard at /queues (framework-level visibility)
 * 4. Health check at /health
 */

import express from "express";
import { startWorker } from "./bullmq/worker.js";
import { startOutboxRelay } from "./bullmq/outbox-relay.js";
import { createDashboard } from "./bullmq/dashboard.js";
import { createPool } from "@nexaas/palace";

const WORKSPACE = process.env.NEXAAS_WORKSPACE;
const CONCURRENCY = parseInt(process.env.NEXAAS_WORKER_CONCURRENCY ?? "5", 10);
const PORT = parseInt(process.env.NEXAAS_WORKER_PORT ?? "9090", 10);

if (!WORKSPACE) {
  console.error("NEXAAS_WORKSPACE is required");
  process.exit(1);
}

async function main() {
  console.log(`[nexaas] Starting worker for workspace: ${WORKSPACE}`);
  console.log(`[nexaas] Concurrency: ${CONCURRENCY}`);

  // Initialize Postgres pool
  createPool();
  console.log("[nexaas] Postgres pool initialized");

  // Start the BullMQ worker
  const worker = startWorker(WORKSPACE!, CONCURRENCY);
  console.log(`[nexaas] BullMQ worker started on queue nexaas:skills:${WORKSPACE}`);

  // Start the outbox relay
  startOutboxRelay(1000);
  console.log("[nexaas] Outbox relay started (polling every 1s)");

  // Express app for Bull Board + health check
  const app = express();

  // Bull Board dashboard — framework-level visibility
  const dashboard = createDashboard(WORKSPACE!);
  app.use("/queues", dashboard.getRouter());
  console.log("[nexaas] Bull Board dashboard at /queues");

  // Health check
  app.get("/health", (req, res) => {
    const isRunning = worker.isRunning();
    res.status(isRunning ? 200 : 503).json({
      status: isRunning ? "healthy" : "unhealthy",
      workspace: WORKSPACE,
      concurrency: CONCURRENCY,
      uptime: process.uptime(),
    });
  });

  // Start the HTTP server
  app.listen(PORT, () => {
    console.log(`[nexaas] Dashboard + health on :${PORT}`);
    console.log(`[nexaas]   /queues  — Bull Board (queue visibility)`);
    console.log(`[nexaas]   /health  — health check`);
  });

  console.log("[nexaas] Worker ready. Waiting for jobs...");
}

main().catch((err) => {
  console.error("[nexaas] Fatal error:", err);
  process.exit(1);
});
