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
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { load as yamlLoad } from "js-yaml";
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

/**
 * Self-heal all cron schedulers by walking every skill.yaml under the
 * workspace's `nexaas-skills/` tree and re-`upsertJobScheduler`'ing each
 * cron trigger. Idempotent — upsertJobScheduler is a no-op when the
 * scheduler already matches.
 *
 * Replaces the older `reconcileStaleRepeatables` which was destructive
 * against modern `upsertJobScheduler` entries (see #31): it called
 * `removeRepeatableByKey` then tried to re-add via the legacy
 * `queue.add(name, {}, { repeat })` API — which silently no-op'd when
 * `job.pattern` was undefined (the common case for modern entries),
 * wiping the scheduler entirely.
 *
 * Also supersedes the intent of #22 (duplicate removal — upsertJobScheduler
 * is keyed by name, so duplicates can't form via this path) and #23
 * (stale catch-up — BullMQ's scheduler handles post-downtime next-fire
 * on its own; no manual re-add needed).
 */
interface SkillManifestForSchedule {
  id: string;
  version?: string;
  timezone?: string;
  triggers?: Array<{ type: string; schedule?: string; timezone?: string }>;
  execution?: { type?: string };
}

function findSkillManifests(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];

  // Structure: nexaas-skills/{category}/{name}/skill.yaml
  // Walk two levels deep; ignore non-directories and anything deeper.
  for (const category of readdirSync(skillsRoot)) {
    const catPath = join(skillsRoot, category);
    try { if (!statSync(catPath).isDirectory()) continue; } catch { continue; }
    for (const name of readdirSync(catPath)) {
      const skillPath = join(catPath, name);
      try { if (!statSync(skillPath).isDirectory()) continue; } catch { continue; }
      const manifestPath = join(skillPath, "skill.yaml");
      if (existsSync(manifestPath)) out.push(manifestPath);
    }
  }
  return out;
}

async function reconcileSkillSchedulers(workspace: string): Promise<{
  registered: number;
  skipped: number;
  errors: number;
}> {
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  if (!workspaceRoot) return { registered: 0, skipped: 0, errors: 0 };
  const skillsRoot = join(workspaceRoot, "nexaas-skills");

  // Resolve workspace default timezone once (trigger → manifest → workspace_config → UTC)
  let workspaceTz = "UTC";
  try {
    const rows = await sql<{ timezone: string }>(
      `SELECT timezone FROM nexaas_memory.workspace_config WHERE workspace = $1`,
      [workspace],
    );
    if (rows[0]?.timezone) workspaceTz = rows[0].timezone;
  } catch { /* workspace_config table missing on pre-013 installs — stay UTC */ }

  const redisOpts = REDIS_URL.startsWith("redis://")
    ? { connection: { url: REDIS_URL } }
    : { connection: { host: "localhost", port: 6379 } };
  const queue = new Queue(`nexaas-skills-${workspace}`, redisOpts);

  let registered = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const manifestPaths = findSkillManifests(skillsRoot);

    for (const manifestPath of manifestPaths) {
      let manifest: SkillManifestForSchedule;
      try {
        manifest = yamlLoad(readFileSync(manifestPath, "utf-8")) as SkillManifestForSchedule;
      } catch (err) {
        console.warn(`[nexaas] skipping malformed manifest ${manifestPath}: ${(err as Error).message}`);
        errors++;
        continue;
      }

      const cronTriggers = (manifest.triggers ?? []).filter((t) => t.type === "cron" && t.schedule);
      if (cronTriggers.length === 0) { skipped++; continue; }

      for (const trigger of cronTriggers) {
        const jobName = `cron-${manifest.id.replace(/\//g, "-")}`;
        const tz = trigger.timezone ?? manifest.timezone ?? workspaceTz;
        const stepId = manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec";

        try {
          await queue.upsertJobScheduler(
            jobName,
            { pattern: trigger.schedule!, tz },
            {
              name: "skill-step",
              data: {
                workspace,
                skillId: manifest.id,
                skillVersion: manifest.version,
                stepId,
                triggerType: "cron",
                manifestPath,
              },
            },
          );
          registered++;
        } catch (err) {
          console.warn(`[nexaas] failed to upsert scheduler for ${manifest.id}: ${(err as Error).message}`);
          errors++;
        }
      }
    }
  } finally {
    await queue.close();
  }

  return { registered, skipped, errors };
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

  // Self-heal cron schedulers on every startup (#31 — replaces the
  // destructive stale-reconcile that wiped upsertJobScheduler entries).
  try {
    const result = await reconcileSkillSchedulers(WORKSPACE!);
    if (result.registered > 0) {
      console.log(
        `[nexaas] Scheduler self-heal: ${result.registered} cron trigger(s) upserted` +
        (result.skipped > 0 ? `, ${result.skipped} manifest(s) without cron skipped` : "") +
        (result.errors > 0 ? `, ${result.errors} error(s)` : ""),
      );
    } else if (result.errors > 0) {
      console.warn(`[nexaas] Scheduler self-heal encountered ${result.errors} error(s) and registered 0 schedulers`);
    }
  } catch (err) {
    console.warn("[nexaas] Scheduler self-heal failed (non-fatal):", (err as Error).message);
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

  // Document ingest — chunk + embed a palace drawer
  app.post("/api/ingest", async (req, res) => {
    try {
      const { drawerId, wing, hall, room, content } = req.body;
      if (!drawerId || !content) {
        res.status(400).json({ error: "drawerId and content required" });
        return;
      }

      const { ingestDocument } = await import("./ingest/index.js");
      const result = await ingestDocument(
        WORKSPACE!,
        drawerId,
        { wing: wing ?? "documents", hall: hall ?? "general", room: room ?? drawerId },
        content,
        {},
      );

      res.json({ ok: true, data: result });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Add-on activation/deactivation
  app.post("/api/addons/activate", async (req, res) => {
    try {
      const { addonId, enable, skills, mcpServers } = req.body as {
        addonId: string;
        enable: boolean;
        skills: string[];
        mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
      };

      if (!addonId) { res.status(400).json({ error: "addonId required" }); return; }

      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("fs");
      const { join } = await import("path");
      const { sql } = await import("@nexaas/palace");
      const wsRoot = process.env.NEXAAS_WORKSPACE_ROOT ?? "";
      const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

      // 1. Update .mcp.json with add-on's MCP servers
      const mcpPath = join(nexaasRoot, ".mcp.json");
      let mcpConfig: Record<string, unknown> = { mcpServers: {} };
      try { mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8")); } catch {}
      const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;

      if (enable && mcpServers) {
        for (const [name, config] of Object.entries(mcpServers)) {
          servers[name] = config;
        }
      } else if (!enable && mcpServers) {
        for (const name of Object.keys(mcpServers)) {
          delete servers[name];
        }
      }

      mcpConfig.mcpServers = servers;
      writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));

      // 2. Install/remove skill manifests from the library
      const results: string[] = [];

      if (enable) {
        for (const skillId of skills) {
          // Check if skill exists in the library
          const libSkill = await sql<{ content: string }>(
            `SELECT content FROM nexaas_memory.events
             WHERE wing = 'library' AND hall = 'skills' AND room = $1
               AND event_type = 'skill-registration'
             ORDER BY created_at DESC LIMIT 1`,
            [skillId],
          );

          if (libSkill.length > 0) {
            const data = JSON.parse(libSkill[0].content);
            const [cat, ...nameParts] = skillId.split("/");
            const skillDir = join(wsRoot, "nexaas-skills", cat!, nameParts.join("/"));
            mkdirSync(skillDir, { recursive: true });

            for (const [filename, fileContent] of Object.entries(data.files ?? {})) {
              writeFileSync(join(skillDir, filename), fileContent as string);
            }

            // Register with BullMQ scheduler
            const manifestPath = join(skillDir, "skill.yaml");
            if (existsSync(manifestPath)) {
              try {
                const { execSync } = await import("child_process");
                execSync(`npx tsx ${nexaasRoot}/packages/cli/src/index.ts register-skill "${manifestPath}"`, {
                  env: { ...process.env },
                  stdio: "pipe",
                  timeout: 30000,
                });
                results.push(`installed: ${skillId}`);
              } catch (e) {
                results.push(`installed but failed to register: ${skillId}`);
              }
            }
          } else {
            results.push(`not in library: ${skillId}`);
          }
        }
      } else {
        // Disable: remove scheduler entries (keep files for now)
        for (const skillId of skills) {
          try {
            const jobName = `cron-${skillId.replace(/\//g, "-")}`;
            const { Queue } = await import("bullmq");
            const { getRedisConnectionOpts: getOpts } = await import("./bullmq/connection.js");
            const q = new Queue(`nexaas-skills-${WORKSPACE}`, getOpts());
            const repeatables = await q.getRepeatableJobs();
            for (const r of repeatables.filter(j => j.name === jobName)) {
              await q.removeRepeatableByKey(r.key);
            }
            await q.close();
            results.push(`disabled: ${skillId}`);
          } catch {
            results.push(`failed to disable: ${skillId}`);
          }
        }
      }

      // 3. WAL audit
      const { appendWal } = await import("@nexaas/palace");
      await appendWal({
        workspace: WORKSPACE!,
        op: enable ? "addon_activated" : "addon_deactivated",
        actor: "dashboard",
        payload: { addon: addonId, skills: results },
      });

      res.json({ ok: true, addon: addonId, enabled: enable, results });
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
