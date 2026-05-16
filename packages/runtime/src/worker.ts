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
import { createPool, sql, appendWal, palace } from "@nexaas/palace";
import { randomUUID } from "crypto";
import { bearerAuth } from "./middleware/bearer-auth.js";
import { runCompaction } from "./tasks/closet-compaction.js";
import { reapExpiredWaitpoints, sendPendingReminders } from "./tasks/waitpoint-reaper.js";
import { runAndRecord, sendAlerts } from "./tasks/health-monitor.js";
import { handlePaMessage } from "./pa/service.js";
import { loadMcpConfigs } from "./mcp/client.js";
import { runGitImport, gitImportPaths } from "./webstudio/git-import.js";
import { runWebstudioEdit, resolveWebstudioMcpEntry } from "./webstudio/edit.js";
import {
  buildSiteArchive, runGitPush, validateCommitMessage,
} from "./webstudio/publish.js";
import { ingestDocument } from "./ingest/index.js";
import { loadWorkspaceManifest } from "./schemas/load-manifest.js";
import { startNotificationDispatcher } from "./tasks/notification-dispatcher.js";
import { startInboundDispatcher } from "./tasks/inbound-dispatcher.js";
import { startApprovalResolver } from "./tasks/approval-resolver.js";
import { startOutputStalenessWatchdog } from "./tasks/output-staleness-watchdog.js";
import { startSchedulerWatchdog } from "./tasks/scheduler-watchdog.js";
import { startBatchDispatcher } from "./tasks/batch-dispatcher.js";
import {
  registerWaitpoint as registerInboundMatch,
  getWaitpointStatus as getInboundMatchStatus,
  cancelWaitpoint as cancelInboundMatch,
  listNamedPatterns,
} from "./tasks/inbound-match-waitpoint.js";
import { executeTrigger, validateTriggerInput } from "./api/skills-trigger.js";
import { executePaNotify, validatePaNotifyInput, defaultPaNotifyDeps } from "./api/pa-notify.js";

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

      const baseJobName = `cron-${manifest.id.replace(/\//g, "-")}`;
      const multiCron = cronTriggers.length > 1;

      // #193: when a manifest has multiple cron triggers, each registers as
      // `${baseJobName}-${idx}` so they don't collapse onto the same key.
      // Migrating a previously-buggy registration (single `baseJobName` key
      // carrying the last cron's pattern) requires explicitly removing the
      // legacy single-key entry; the new idx-suffixed upserts wouldn't replace
      // it. Single-cron manifests keep `baseJobName` as before — no migration.
      if (multiCron) {
        try {
          const existing = await queue.getRepeatableJobs();
          for (const r of existing.filter((j) => j.name === baseJobName)) {
            await queue.removeRepeatableByKey(r.key);
          }
        } catch { /* non-fatal — cleanup is opportunistic */ }
      }

      for (const [idx, trigger] of cronTriggers.entries()) {
        const jobName = multiCron ? `${baseJobName}-${idx}` : baseJobName;
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
          console.warn(`[nexaas] failed to upsert scheduler for ${manifest.id} (trigger ${idx}): ${(err as Error).message}`);
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

  // ─── Cross-VPS framework API (#53, #64) ──────────────────────────────
  // Endpoints below accept writes from peer VPSes in operator-managed
  // mode (e.g., a Nexmatic ops-VPS Telegram relay forwarding inbound
  // drawers to a client VPS). Gated by bearerAuth() — when
  // NEXAAS_CROSS_VPS_BEARER_TOKEN is set, requires matching bearer;
  // when unset, passes through (direct-adopter backward compat).

  // ─── Inbound-match waitpoint API (#49) ──────────────────────────────
  // HTTP-accessible channel-agnostic pattern-matched message capture for
  // non-skill callers (Python scripts, shell tools, external CLIs). See
  // packages/runtime/src/tasks/inbound-match-waitpoint.ts for semantics.

  app.post("/api/waitpoints/inbound-match", bearerAuth(), async (req, res) => {
    try {
      const body = req.body ?? {};
      if (typeof body.workspace !== "string" || !body.match) {
        res.status(400).json({ error: "workspace and match are required" });
        return;
      }
      const result = await registerInboundMatch({
        workspace: body.workspace,
        match: body.match,
        timeout_seconds: body.timeout_seconds,
        extract: body.extract,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      });
      if ("error" in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/waitpoints/inbound-match/patterns", bearerAuth(), (_req, res) => {
    res.json({ named_patterns: listNamedPatterns() });
  });

  app.get("/api/waitpoints/:id", bearerAuth(), async (req, res) => {
    try {
      const workspace = (req.query.workspace as string | undefined) ?? WORKSPACE;
      if (!workspace) {
        res.status(400).json({ error: "workspace query param required" });
        return;
      }
      const status = await getInboundMatchStatus(workspace, req.params.id as string);
      if (!status) {
        res.status(404).json({ error: "waitpoint not found" });
        return;
      }
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/waitpoints/:id", bearerAuth(), async (req, res) => {
    try {
      const workspace = (req.query.workspace as string | undefined) ?? WORKSPACE;
      if (!workspace) {
        res.status(400).json({ error: "workspace query param required" });
        return;
      }
      const ok = await cancelInboundMatch(workspace, req.params.id as string);
      if (!ok) {
        res.status(404).json({ error: "waitpoint not found or already resolved" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Generic cross-VPS inbound-drawer landing (#64) ─────────────────
  // Accepts a canonical v0.2 messaging-inbound drawer from a peer VPS
  // (ops-VPS channel relay) and writes it to inbox.messaging.<role>.
  // Channel-agnostic — same endpoint serves Telegram relay, email
  // forwarding, SMS gateway, etc. The caller's relay code owns the
  // routing (chat_id/to-address/etc. → workspace + channel_role);
  // framework owns the landing + WAL audit trail.
  //
  // Once the drawer lands, the inbound dispatcher's poll cycle picks
  // it up and routes to subscribed skills (inbound-match waitpoints
  // resolve within one dispatcher tick).

  // ─── Manual skill trigger (#83) ─────────────────────────────────────
  // HTTP peer of `nexaas trigger-skill` for the dashboard, external
  // webhooks, and any add-on UX with a "do it now" button. Same auth
  // posture as the waitpoint/inbound endpoints — bearer when
  // NEXAAS_CROSS_VPS_BEARER_TOKEN is set, pass-through otherwise.

  app.post("/api/skills/trigger", bearerAuth(), async (req, res) => {
    try {
      const validated = validateTriggerInput(req.body);
      if ("error" in validated) {
        res.status(validated.status).json({ error: validated.error });
        return;
      }
      const outcome = await executeTrigger(validated, {
        workspaceRoot: process.env.NEXAAS_WORKSPACE_ROOT ?? "/opt/nexaas",
        defaultWorkspace: WORKSPACE,
        enqueue: async (queueName, jobName, data, opts) => {
          const queue = new Queue(queueName, getRedisConnectionOpts());
          try {
            const job = await queue.add(jobName, data, opts);
            return { id: job.id };
          } finally {
            await queue.close();
          }
        },
        audit: async (entry) => { await appendWal(entry); },
      });
      if ("error" in outcome) {
        res.status(outcome.status).json({ error: outcome.error });
        return;
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PA-as-Router endpoint (RFC-0002 §3.2, Wave 2, #123). Skills that target
  // a specific user route through that user's PA via this endpoint; the PA
  // owns thread placement, urgency, render, and audit. Pending drawer lands
  // at notifications.pending.pa-routed.<thread_id> for the PA's
  // conversation-turn skill to consume via its inbound-message trigger.
  app.post("/api/pa/:user/notify", bearerAuth(), async (req, res) => {
    try {
      const userParam = req.params.user;
      const validated = validatePaNotifyInput(
        Array.isArray(userParam) ? userParam[0] ?? "" : userParam ?? "",
        req.body,
      );
      if ("error" in validated) {
        res.status(validated.status).json({ error: validated.error, details: validated.details });
        return;
      }
      if (!WORKSPACE) {
        res.status(500).json({ error: "worker has no NEXAAS_WORKSPACE configured" });
        return;
      }
      const outcome = await executePaNotify(validated, defaultPaNotifyDeps(WORKSPACE), {
        source: "direct",
        decision: "delivered",
        reason: "success",
      });
      if ("error" in outcome) {
        res.status(outcome.status).json({ error: outcome.error, details: outcome.details });
        return;
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/drawers/inbound", bearerAuth(), async (req, res) => {
    try {
      const body = req.body ?? {};
      if (typeof body.workspace !== "string" || !body.workspace) {
        res.status(400).json({ error: "workspace is required" });
        return;
      }
      if (typeof body.channel_role !== "string" || !body.channel_role) {
        res.status(400).json({ error: "channel_role is required" });
        return;
      }
      if (!body.message || typeof body.message !== "object" || Array.isArray(body.message)) {
        res.status(400).json({ error: "message is required and must be an object" });
        return;
      }
      const msg = body.message as Record<string, unknown>;
      if (typeof msg.content !== "string" && !msg.action_button_click && !Array.isArray(msg.attachments)) {
        res.status(400).json({ error: "message must have content, attachments, or action_button_click" });
        return;
      }

      const runId = randomUUID();
      const session = palace.enter({
        workspace: body.workspace,
        runId,
        skillId: "system:inbound-relay",
        stepId: "relay-ingest",
      });

      const drawerId = await session.writeDrawer(
        { wing: "inbox", hall: "messaging", room: body.channel_role },
        JSON.stringify(msg),
      );

      await appendWal({
        workspace: body.workspace,
        op: "inbound_drawer_relayed",
        actor: "inbound-relay",
        payload: {
          channel_role: body.channel_role,
          drawer_id: drawerId,
          message_id: typeof msg.id === "string" ? msg.id : undefined,
          from: typeof msg.from === "string" ? msg.from : undefined,
          has_attachments: Array.isArray(msg.attachments) && msg.attachments.length > 0,
          has_action_button_click: Boolean(msg.action_button_click),
        },
      });

      res.status(201).json({ ok: true, drawer_id: drawerId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

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

  // Import: download site with wget (method=scrape) or clone a git
  // repo + spawn its dev server (method=git, #147).
  app.post("/api/webstudio/import", bearerAuth(), async (req, res) => {
    try {
      const { url, method } = req.body;
      if (!url) { res.status(400).json({ error: "url required" }); return; }


      mkdirSync(WS_SITE_DIR, { recursive: true });

      if (method === "git") {
        const paths = gitImportPaths(
          process.env.NEXAAS_ROOT ?? "/opt/nexaas",
          WORKSPACE ?? "default",
        );
        try {
          const result = await runGitImport({
            url,
            branch: typeof req.body.branch === "string" ? req.body.branch : undefined,
            deployKey: typeof req.body.deployKey === "string" ? req.body.deployKey : undefined,
            auth: req.body.auth,
          }, paths);
          console.log(`[webstudio] Git import: ${url}@${result.branch} (${result.framework}), pid=${result.devServerPid}`);
          res.json({ ok: true, data: { ...result, method: "git" } });
        } catch (err) {
          res.status(400).json({ ok: false, error: (err as Error).message });
        }
        return;
      }

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
        res.status(400).json({ error: `Import method '${method}' not supported (use 'scrape' or 'git')` });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Edit: PA modifies files in the working copy via the webstudio MCP
  // server (#148). Resolves the working copy in this priority:
  //   1. git import (#147): web-studio/<workspace>/repo/
  //   2. scrape: web-studio/<workspace>/site/<hostname>/  (or site/)
  app.post("/api/webstudio/edit", bearerAuth(), async (req, res) => {
    try {
      const { instruction, senderName } = req.body;
      if (!instruction) { res.status(400).json({ error: "instruction required" }); return; }

      const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
      const ws = WORKSPACE ?? "default";
      const gitRepoRoot = join(nexaasRoot, "web-studio", ws, "repo");
      let repoRoot: string;
      if (existsSync(gitRepoRoot)) {
        repoRoot = gitRepoRoot;
      } else {
        // Fall back to the scrape layout. Use the hostname subdir if
        // wget created one (its usual behavior); otherwise the bare site
        // dir.
        const hostname = existsSync(WS_SITE_DIR)
          ? readdirSync(WS_SITE_DIR).find(d => !d.startsWith("."))
          : undefined;
        repoRoot = hostname ? join(WS_SITE_DIR, hostname) : WS_SITE_DIR;
      }

      if (!existsSync(repoRoot)) {
        res.status(400).json({
          ok: false,
          error: "No working copy found. Run /api/webstudio/import first.",
        });
        return;
      }

      const mcpEntry = resolveWebstudioMcpEntry(nexaasRoot);
      const result = await runWebstudioEdit(ws, repoRoot, mcpEntry, {
        instruction,
        senderName,
      });

      res.json({
        ok: true,
        data: {
          previewUrl: `http://localhost:${WS_PORT}`,
          response: result.response,
          turns: result.turns,
          toolCalls: result.toolCalls,
          filesWritten: result.filesWritten,
          filesRead: result.filesRead,
          applied: result.applied,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  // Publish: stream the working copy back as tar.gz (method=zip) or
  // push to the origin remote (method=git_push). Replaces the
  // dashboard's in-process ZIP build so non-Nexmatic adopters get the
  // same flow. See #149.
  app.post("/api/webstudio/publish", bearerAuth(), async (req, res) => {
    try {
      const method = req.body?.method;
      const ws = WORKSPACE ?? "default";
      const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
      const session = palace.enter({ workspace: ws });

      if (method === "zip") {
        // Use the scrape site dir; if a git repo was imported, the
        // operator can ZIP that too — it's the same shape, just a
        // different root.
        const gitRepoRoot = join(nexaasRoot, "web-studio", ws, "repo");
        let root: string;
        let hostnameHint: string | undefined;
        if (existsSync(gitRepoRoot)) {
          root = gitRepoRoot;
        } else {
          const hostname = existsSync(WS_SITE_DIR)
            ? readdirSync(WS_SITE_DIR).find(d => !d.startsWith("."))
            : undefined;
          hostnameHint = hostname;
          root = hostname ? join(WS_SITE_DIR, hostname) : WS_SITE_DIR;
        }
        if (!existsSync(root)) {
          res.status(400).json({ ok: false, error: "No working copy to publish. Run /api/webstudio/import first." });
          return;
        }
        const archive = buildSiteArchive(root, hostnameHint);
        res.setHeader("Content-Type", archive.contentType);
        res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
        archive.stream.pipe(res);
        archive.stream.on("end", async () => {
          await session.writeDrawer(
            { wing: "events", hall: "web-studio", room: "publishes" },
            JSON.stringify({
              method: "zip",
              workspace: ws,
              root,
              filename: archive.filename,
              ts: new Date().toISOString(),
              actor: req.body?.actor,
            }),
          ).catch(() => { /* best effort */ });
        });
        archive.stream.on("error", (err) => {
          if (!res.headersSent) {
            res.status(500).json({ ok: false, error: err.message });
          } else {
            res.end();
          }
        });
        return;
      }

      if (method === "git_push") {
        const validation = validateCommitMessage(req.body?.commitMessage);
        if (!validation.ok) {
          res.status(400).json({ ok: false, error: validation.error });
          return;
        }
        const repoRoot = join(nexaasRoot, "web-studio", ws, "repo");
        const deployKeyPath = join(nexaasRoot, ".ssh", `${ws}_deploy_key`);
        const result = await runGitPush({
          repoRoot,
          commitMessage: validation.message,
          deployKeyPath,
          authorName: typeof req.body?.authorName === "string" ? req.body.authorName : undefined,
          authorEmail: typeof req.body?.authorEmail === "string" ? req.body.authorEmail : undefined,
        });
        if (!result.changed) {
          res.status(204).setHeader("X-Nexaas-Publish-Reason", "no_changes").end();
          await session.writeDrawer(
            { wing: "events", hall: "web-studio", room: "publishes" },
            JSON.stringify({
              method: "git_push",
              workspace: ws,
              changed: false,
              reason: "no_changes",
              ts: new Date().toISOString(),
              actor: req.body?.actor,
            }),
          ).catch(() => { /* best effort */ });
          return;
        }
        await session.writeDrawer(
          { wing: "events", hall: "web-studio", room: "publishes" },
          JSON.stringify({
            method: "git_push",
            workspace: ws,
            changed: true,
            branch: result.branch,
            commit_sha: result.commitSha,
            commit_message: validation.message,
            ts: new Date().toISOString(),
            actor: req.body?.actor,
          }),
        ).catch(() => { /* best effort */ });
        res.json({
          ok: true,
          data: {
            method: "git_push",
            branch: result.branch,
            commitSha: result.commitSha,
            pushOutput: result.pushOutput,
          },
        });
        return;
      }

      if (method === "ftp") {
        res.status(400).json({ ok: false, error: "method=ftp not yet implemented" });
        return;
      }

      res.status(400).json({ ok: false, error: `unknown method '${method}'. Use 'zip' or 'git_push'.` });
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
        // Disable: remove scheduler entries (keep files for now). Prefix
        // match handles multi-cron manifests where each trigger registers
        // as `${baseJobName}-${idx}` (#193).
        for (const skillId of skills) {
          try {
            const baseJobName = `cron-${skillId.replace(/\//g, "-")}`;
            const q = new Queue(`nexaas-skills-${WORKSPACE}`, getRedisConnectionOpts());
            const repeatables = await q.getRepeatableJobs();
            for (const r of repeatables.filter(j =>
              j.name === baseJobName || j.name.startsWith(`${baseJobName}-`)
            )) {
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

    // Outbound notification dispatcher (#40) — watches notifications.pending.*
    // drawers and dispatches via bound channel MCPs. No-op when no
    // manifest / no bindings, so safe to start unconditionally.
    startNotificationDispatcher(WORKSPACE!);

    // Inbound-message dispatcher (#39) — watches inbox.messaging.<role>
    // drawers and enqueues a BullMQ job per subscribed skill. No-op when
    // no skills declare inbound-message triggers.
    startInboundDispatcher(WORKSPACE!);

    // Approval-callback resolver — companion to #39 + #40 + #45 Stage 1a.
    // Watches inbox.messaging.* drawers containing action_button_click
    // that correspond to a TAG-emitted approval-request, resolves the
    // waitpoint, enqueues skill resumption. Coexists with the inbound
    // dispatcher (skills can subscribe to the same drawer and also see
    // the button click).
    startApprovalResolver(WORKSPACE!);

    // Output-cadence staleness watchdog (#86 Gap 1) — alerts when a
    // declared output hasn't been produced within max_silence. No-op
    // for skills without staleness_alert config; per-output channel_role
    // routes via the existing notification-dispatcher.
    const skillsRoot = join(process.env.NEXAAS_WORKSPACE_ROOT ?? "/opt/nexaas", "nexaas-skills");
    startOutputStalenessWatchdog(WORKSPACE!, skillsRoot);

    // Scheduler watchdog (#86 Gap 2) — alerts on cron triggers that should
    // have fired but didn't. Disabled when NEXAAS_SCHEDULER_WATCHDOG_CHANNEL_ROLE
    // is unset; opt-in for adopters who want overdue-cron visibility.
    const schedulerQueue = new Queue(`nexaas-skills-${WORKSPACE}`, {
      connection: getRedisConnectionOpts().connection,
    });
    startSchedulerWatchdog(WORKSPACE!, schedulerQueue);

    // Batch dispatcher (#80) — accumulates drawers in batch.<bucket>.pending.*
    // and fires the consumer skill when fire_when conditions match (count,
    // age, cron, deadline). No-op when no skill declares a `batch` trigger.
    startBatchDispatcher(WORKSPACE!);

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
