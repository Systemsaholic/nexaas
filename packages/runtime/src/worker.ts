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
import {
  readdirSync, readFileSync, existsSync, statSync,
  writeFileSync, mkdirSync,
} from "fs";
import { join } from "path";
import { promisify } from "util";
import { exec as execCallback, spawn } from "child_process";
import { load as yamlLoad } from "js-yaml";
// IMPORTANT: static imports only. `await import(...)` inside an HTTP
// handler round-trips through tsx/esbuild's IPC (epoll fd 62), which
// blocks the main thread from draining the HTTP listener on libuv's
// main epoll (fd 13). Symptom is /health hanging for minutes at a time
// while BullMQ jobs continue to process. See #33.
import { startWorker } from "./bullmq/worker.js";
import { startOutboxRelay } from "./bullmq/outbox-relay.js";
import { createDashboard } from "./bullmq/dashboard.js";
import { getRedisConnectionOpts } from "./bullmq/connection.js";
import { createPool, sql, appendWal } from "@nexaas/palace";
import { runCompaction } from "./tasks/closet-compaction.js";
import { reapExpiredWaitpoints, sendPendingReminders } from "./tasks/waitpoint-reaper.js";
import { runAndRecord, sendAlerts } from "./tasks/health-monitor.js";
import { handlePaMessage } from "./pa/service.js";
import { loadMcpConfigs } from "./mcp/client.js";
import { ingestDocument } from "./ingest/index.js";
import { loadWorkspaceManifest } from "./schemas/load-manifest.js";

// Async exec for use inside HTTP handlers. Never use execSync in a route
// handler — it blocks the Node event loop, which wedges /health, /queues,
// /api/pa/message, and any other consumer of this port for the duration
// (up to 2 minutes for the wget mirror below). See #33.
const execAsync = promisify(execCallback);

const WORKSPACE = process.env.NEXAAS_WORKSPACE;
const CONCURRENCY = parseInt(process.env.NEXAAS_WORKER_CONCURRENCY ?? "5", 10);
const PORT = parseInt(process.env.NEXAAS_WORKER_PORT ?? "9090", 10);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

if (!WORKSPACE) {
  console.error("NEXAAS_WORKSPACE is required");
  process.exit(1);
}

// Process-level safety net. pg-pool's 'error' event is already handled
// (see #34), but there are many other ways an async error can escape
// the enclosing try/catch — library bugs, ill-formed tool responses,
// socket teardowns mid-promise. Log the full context so post-mortems
// have something to work with, then either crash (uncaughtException —
// state is inconsistent) or keep running (unhandledRejection — often
// a forgotten await, not fatal).
process.on("uncaughtException", (err, origin) => {
  console.error(`[nexaas] uncaughtException (${origin}): ${err.message}`);
  console.error(err.stack);
  // Best-effort WAL entry so the restart shows up with context.
  appendWal({
    workspace: WORKSPACE!,
    op: "worker_crashed",
    actor: "process",
    payload: {
      origin,
      error: err.message,
      stack: (err.stack ?? "").slice(0, 2000),
      pid: process.pid,
      uptime_s: process.uptime(),
    },
  }).catch(() => { /* DB may be the thing that broke */ });
  // Exit so systemd restarts us. Process state is too uncertain to continue.
  setTimeout(() => process.exit(1), 500);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[nexaas] unhandledRejection: ${err.message}`);
  if (err.stack) console.error(err.stack);
  // Do NOT exit — a forgotten await in one skill shouldn't take down the
  // whole worker. Log for diagnosis and keep serving other work.
  appendWal({
    workspace: WORKSPACE!,
    op: "worker_unhandled_rejection",
    actor: "process",
    payload: {
      error: err.message,
      stack: (err.stack ?? "").slice(0, 2000),
      pid: process.pid,
      uptime_s: process.uptime(),
    },
  }).catch(() => { /* best effort */ });
});

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

// Worker lifecycle state observable via /health. Kept module-level so the
// /health handler closure sees the latest value as startup progresses.
let serverState: "booting" | "initializing" | "ready" | "failed" = "booting";
let workerRef: import("bullmq").Worker | null = null;
let startupError: string | null = null;

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

  // Initialize Postgres pool — needed before anything queries the DB.
  createPool();
  console.log("[nexaas] Postgres pool initialized");

  // ─── Express server comes up FIRST so /health is responsive within
  // a couple of seconds of boot, not after the 20-30s reconcile work
  // below. Operators (and `nexaas upgrade`) get an immediate
  // `state: booting` / `state: initializing` signal instead of timeouts
  // during warmup (#33).
  const app = express();

  app.get("/health", (_req, res) => {
    const isRunning = workerRef?.isRunning() === true;
    const ready = serverState === "ready" && isRunning;
    res.status(ready ? 200 : 503).json({
      status: ready ? "healthy" : (serverState === "failed" ? "failed" : "initializing"),
      state: serverState,
      workspace: WORKSPACE,
      concurrency: CONCURRENCY,
      uptime: process.uptime(),
      startup_error: startupError,
    });
  });

  // Bull Board is registered AFTER the BullMQ worker comes up (see below)
  // because createDashboard() needs live queue handles. Until then, /queues
  // returns a 503 via the fallback below.
  app.get("/queues*", (_req, res, next) => {
    if (serverState === "ready") return next();
    res.status(503).json({ error: "dashboard not yet available", state: serverState });
  });

  // PA HTTP adapter — enables client dashboard to use the full PA service
  app.use(express.json());

  app.post("/api/pa/message", async (req, res) => {
    try {

      const { message, senderName, senderId, channel, threadId, systemPrompt } = req.body;

      if (!message) {
        res.status(400).json({ error: "message required" });
        return;
      }

      // Auto-discover MCP servers from workspace .mcp.json
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

  // ─── WebStudio endpoints ────────────────────────────────────────────

  const WS_SITE_DIR = join(process.env.NEXAAS_ROOT ?? "/opt/nexaas", "web-studio", WORKSPACE ?? "default", "site");
  const WS_PORT = 3002;

  // Import: download site with wget
  app.post("/api/webstudio/import", async (req, res) => {
    try {
      const { url, method } = req.body;
      if (!url) { res.status(400).json({ error: "url required" }); return; }


      mkdirSync(WS_SITE_DIR, { recursive: true });

      if (method === "scrape" || !method) {
        // Download site with wget mirror — async so we don't wedge the
        // whole HTTP server for up to 2 minutes while wget runs (#33).
        try {
          await execAsync(
            `wget --mirror --convert-links --adjust-extension --page-requisites --no-parent --timeout=30 --tries=2 -q -P "${WS_SITE_DIR}" "${url}" 2>&1 || true`,
            { timeout: 120000 },
          );
        } catch {
          // wget may exit non-zero but still download files
        }

        // Count downloaded files
        let fileCount = 0;
        const countFiles = (dir: string): void => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) countFiles(join(dir, entry.name));
              else fileCount++;
            }
          } catch {}
        };
        countFiles(WS_SITE_DIR);

        // Start or restart the static file server
        try {
          await execAsync(`fuser -k ${WS_PORT}/tcp 2>/dev/null || true`);
        } catch {}

        // Find the actual site directory (wget creates hostname subdirectory)
        const hostname = new URL(url).hostname;
        const siteRoot = existsSync(join(WS_SITE_DIR, hostname))
          ? join(WS_SITE_DIR, hostname)
          : WS_SITE_DIR;

        // Start a simple static server in background
        const server = spawn("npx", ["-y", "serve", "-l", String(WS_PORT), "-s", siteRoot], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env },
        });
        server.unref();

        console.log(`[webstudio] Site downloaded: ${fileCount} files from ${url}, serving on :${WS_PORT}`);

        res.json({
          ok: true,
          data: {
            previewUrl: `http://localhost:${WS_PORT}`,
            fileCount,
            siteRoot,
            method: "scrape",
          },
        });
      } else {
        res.status(400).json({ error: `Import method '${method}' not yet implemented` });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Edit: AI modifies files in the working copy
  app.post("/api/webstudio/edit", async (req, res) => {
    try {
      const { instruction, senderName } = req.body;
      if (!instruction) { res.status(400).json({ error: "instruction required" }); return; }


      // Find the site root
      const hostname = readdirSync(WS_SITE_DIR).find(d => !d.startsWith("."));
      const siteRoot = hostname ? join(WS_SITE_DIR, hostname) : WS_SITE_DIR;

      // List HTML files
      const htmlFiles: string[] = [];
      const walkHtml = (dir: string, prefix = ""): void => {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory() && !entry.name.startsWith(".")) walkHtml(join(dir, entry.name), rel);
            else if (entry.name.endsWith(".html") || entry.name.endsWith(".htm")) htmlFiles.push(rel);
          }
        } catch {}
      };
      walkHtml(siteRoot);

      // Read the main HTML file (index.html or first found)
      const mainFile = htmlFiles.find(f => f === "index.html") ?? htmlFiles[0];
      if (!mainFile) {
        res.json({ ok: false, error: "No HTML files found in working copy" });
        return;
      }

      const mainContent = readFileSync(join(siteRoot, mainFile), "utf-8");

      // Use the PA to generate the edit
      const result = await handlePaMessage(WORKSPACE!, {
        id: "webstudio-editor",
        displayName: "WebStudio Editor",
        type: "human-facing" as const,
        owner: senderName ?? "user",
        modelTier: "good",
        systemPrompt: `You are a web developer assistant. The user wants to modify their website.

Current HTML file (${mainFile}):
\`\`\`html
${mainContent.slice(0, 15000)}
\`\`\`

${htmlFiles.length > 1 ? `Other files: ${htmlFiles.join(", ")}` : ""}

The user's instruction: "${instruction}"

Generate the COMPLETE modified HTML file with the requested changes applied. Output ONLY the full HTML — no explanations, no markdown code blocks, just the raw HTML that should replace the file.`,
        mcpServers: [],
        palaceAccess: { read: ["*"], deny: [] },
        channels: ["web-studio"],
        maxTurns: 3,
      }, {
        channel: "web-studio",
        senderId: "webstudio",
        senderName: senderName ?? "User",
        content: instruction,
      });

      // Extract the HTML from the response
      let newHtml = result.response;

      // Clean up — remove markdown code fences if present
      const htmlMatch = newHtml.match(/```html?\n([\s\S]*?)```/);
      if (htmlMatch) newHtml = htmlMatch[1];

      // If it looks like complete HTML, write it
      if (newHtml.includes("<") && newHtml.includes(">")) {
        writeFileSync(join(siteRoot, mainFile), newHtml);

        res.json({
          ok: true,
          data: {
            file: mainFile,
            description: instruction,
            previewUrl: `http://localhost:${WS_PORT}`,
            applied: true,
          },
        });
      } else {
        res.json({
          ok: true,
          data: {
            file: mainFile,
            description: result.response.slice(0, 200),
            previewUrl: `http://localhost:${WS_PORT}`,
            applied: false,
            response: result.response,
          },
        });
      }
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

            // Register with BullMQ scheduler — async exec so activation
            // doesn't block /health and /queues for 30s (#33).
            const manifestPath = join(skillDir, "skill.yaml");
            if (existsSync(manifestPath)) {
              try {
                await execAsync(
                  `npx tsx ${nexaasRoot}/packages/cli/src/index.ts register-skill "${manifestPath}"`,
                  { env: { ...process.env } as NodeJS.ProcessEnv, timeout: 30000 },
                );
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
            const q = new Queue(`nexaas-skills-${WORKSPACE}`, getRedisConnectionOpts());
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

  // Start the HTTP server NOW, before the heavy init. /health reports
  // state=booting / state=initializing while the rest of startup runs.
  const server = app.listen(PORT, () => {
    console.log(`[nexaas] HTTP listening on :${PORT} (state=${serverState})`);
  });

  // Cap connection lifetime so slow or abandoned clients don't
  // accumulate CLOSE-WAIT sockets on port 9090 (#33).
  server.headersTimeout = 60_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[nexaas] FATAL: HTTP server error: ${err.message}`);
    process.exit(1);
  });

  // ─── Heavy init runs AFTER the HTTP server is accepting connections.
  // Any error here flips serverState to "failed" without exiting — the
  // HTTP server stays up so operators can see the failure via /health.
  serverState = "initializing";

  try {
    // Reconcile orphaned skill_runs from prior crashes (#21).
    try {
      const reconciled = await reconcileOrphanedRuns(WORKSPACE!);
      if (reconciled > 0) {
        console.log(`[nexaas] Reconciled ${reconciled} orphaned skill_runs from prior crash`);
      }
    } catch (err) {
      console.warn("[nexaas] Orphan reconciliation failed (non-fatal):", (err as Error).message);
    }

    // Load + validate the workspace manifest (architecture.md §16, issue #41).
    // Fail-open: missing or malformed manifests only generate warnings.
    // Framework continues with built-in defaults so deployed workspaces
    // that haven't migrated yet keep running.
    try {
      const { manifest, warnings, errors } = await loadWorkspaceManifest(WORKSPACE!);
      if (errors.length > 0) {
        console.warn(`[nexaas] Manifest validation errors (${errors.length}) for ${WORKSPACE}:`);
        for (const e of errors.slice(0, 10)) console.warn(`  - ${e}`);
      }
      if (warnings.length > 0) {
        for (const w of warnings.slice(0, 5)) console.warn(`[nexaas] Manifest warning: ${w}`);
      }
      if (manifest) {
        const capCount = Object.keys(manifest.capability_bindings).length;
        const chCount = Object.keys(manifest.channel_bindings).length;
        console.log(
          `[nexaas] Manifest loaded (v${manifest.manifest_version}): ${capCount} capability binding(s), ${chCount} channel binding(s), ${manifest.installed_agents.length} agent(s)`,
        );
      }
    } catch (err) {
      console.warn("[nexaas] Manifest load failed (non-fatal):", (err as Error).message);
    }

    // Self-heal cron schedulers (#31).
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

    // Start the BullMQ worker.
    workerRef = startWorker(WORKSPACE!, CONCURRENCY);
    console.log(`[nexaas] BullMQ worker started on queue nexaas-skills-${WORKSPACE}`);

    // Start the outbox relay.
    startOutboxRelay(1000);
    console.log("[nexaas] Outbox relay started (polling every 1s)");

    // Register Bull Board now that BullMQ queues are live.
    const dashboard = createDashboard(WORKSPACE!);
    app.use("/queues", dashboard.getRouter());
    console.log("[nexaas] Bull Board dashboard at /queues");

    serverState = "ready";
    console.log("[nexaas] Worker ready.");
  } catch (err) {
    serverState = "failed";
    startupError = err instanceof Error ? err.message : String(err);
    console.error("[nexaas] FATAL: startup init failed:", err);
    // Keep the HTTP server running so operators can see /health return
    // state=failed instead of getting connection refused.
  }

  // Background tasks
  setInterval(async () => {
    try {
      const compacted = await runCompaction(WORKSPACE!);
      if (compacted > 0) console.log(`[nexaas] Compacted ${compacted} drawers into closets`);
    } catch (err) {
      console.error("[nexaas] Compaction error:", err);
    }
  }, 5 * 60 * 1000);

  // WAL retention — opt-in. Set NEXAAS_WAL_RETENTION_DAYS to a positive
  // integer to delete WAL entries older than that many days. Runs every
  // 6 hours, deletes in 10k-row batches to avoid long locks. Safe to
  // enable/disable at runtime: unset the env var + restart to turn off.
  //
  // Chain integrity: the WAL uses prev_hash linking. Deleting old rows
  // breaks the chain from the start but verification from the oldest
  // remaining entry forward still works. Run `nexaas verify-wal --full`
  // before enabling if chain-from-genesis verifiability matters for the
  // workspace.
  const walRetentionDays = parseInt(process.env.NEXAAS_WAL_RETENTION_DAYS ?? "0", 10);
  if (walRetentionDays > 0) {
    setInterval(async () => {
      try {
        let totalDeleted = 0;
        while (true) {
          const rows = await sql<{ id: number }>(
            `DELETE FROM nexaas_memory.wal
              WHERE id IN (
                SELECT id FROM nexaas_memory.wal
                 WHERE workspace = $1
                   AND created_at < now() - ($2 || ' days')::interval
                 ORDER BY id ASC
                 LIMIT 10000
              )
            RETURNING id`,
            [WORKSPACE!, walRetentionDays.toString()],
          );
          totalDeleted += rows.length;
          if (rows.length < 10000) break;
        }
        if (totalDeleted > 0) {
          console.log(`[nexaas] WAL retention: deleted ${totalDeleted} entries older than ${walRetentionDays} days`);
        }
      } catch (err) {
        console.error("[nexaas] WAL retention error:", err);
      }
    }, 6 * 60 * 60 * 1000);
    console.log(`[nexaas] WAL retention: enabled (delete entries older than ${walRetentionDays} days)`);
  }

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

  // Periodic orphan-run reaper (#36) — catches skill_runs that got stuck
  // in `running` while the worker was alive (executor threw before the
  // try/catch fired, or some other rare path escaped status updates).
  // The startup reaper only runs once; this one keeps the table honest
  // over long-lived worker processes. Threshold 20 min — well past the
  // legitimate completion time of any single-turn ai-skill under the
  // current guardrails (max 10 turns × 60s timeout = 10 min).
  setInterval(async () => {
    try {
      const reaped = await sql<{ run_id: string }>(
        `UPDATE nexaas_memory.skill_runs
            SET status = 'cancelled',
                completed_at = COALESCE(completed_at, now()),
                error_summary = COALESCE(error_summary,
                  'reaped: status=running and last_activity stale for 20m+')
          WHERE workspace = $1
            AND status = 'running'
            AND last_activity < now() - interval '20 minutes'
          RETURNING run_id`,
        [WORKSPACE!],
      );
      if (reaped.length > 0) {
        console.warn(
          `[nexaas] Reaped ${reaped.length} orphaned skill_runs (last_activity stale for 20m+)`,
        );
      }
    } catch (err) {
      console.error("[nexaas] Orphan-run reaper error:", err);
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
