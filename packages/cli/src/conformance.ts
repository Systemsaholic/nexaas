/**
 * nexaas conformance — prove a VPS install works end-to-end at $0 AI spend (#213).
 *
 * `nexaas health` checks that components are up; this command checks that the
 * framework *works*: pillar pipeline, queue→worker round-trip, waitpoint
 * matching, WAL integrity, migration state. Designed to run on a live
 * production VPS without side effects — every execution probe is namespaced
 * under `conformance/` ids, writes only to `ops.conformance.*` rooms, and
 * cleans up after itself. AI-skill execution is served by a local mock model
 * server (ANTHROPIC_BASE_URL override inside this process only), so no API
 * dollars are spent and the live worker's environment is never touched.
 *
 * Usage:
 *   nexaas conformance                  Run infra + execution proofs
 *   nexaas conformance --skip-execution Infra checks only (no skill runs)
 *   nexaas conformance --with-backup    Also run a backup and verify history
 *   nexaas conformance --json           Machine-readable output
 *   nexaas conformance --keep-artifacts Leave temp manifests on disk for debugging
 *
 * Exit codes: 0 = all pass (skips allowed), 1 = at least one failure,
 *             2 = cannot run (missing env / DB unreachable).
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import pg from "pg";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { verifyWalChain } from "@nexaas/palace";
import { startMockModelServer, MOCK_REPLY_TEXT } from "./conformance-mock-model.js";
import { gatherState } from "./migration-state.js";

interface CheckResult {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  duration_ms: number;
}

const SHELL_ROUNDTRIP_TIMEOUT_MS = 60_000;
const WAITPOINT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function workerBase(): string {
  return `http://localhost:${process.env.NEXAAS_WORKER_PORT ?? "9090"}`;
}

function bearerHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = process.env.NEXAAS_CROSS_VPS_BEARER_TOKEN;
  if (token) headers["authorization"] = `Bearer ${token}`;
  return headers;
}

export async function run(args: string[] = []) {
  const json = args.includes("--json");
  const skipExecution = args.includes("--skip-execution");
  const withBackup = args.includes("--with-backup");
  const keepArtifacts = args.includes("--keep-artifacts");

  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;
  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL are required");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.error(`Cannot reach Postgres: ${(err as Error).message}`);
    await pool.end();
    process.exit(2);
  }

  const results: CheckResult[] = [];
  let workerHealthy = false;
  let redisHealthy = false;

  async function check(id: string, fn: () => Promise<{ status: CheckResult["status"]; detail: string }>) {
    const start = Date.now();
    try {
      const r = await fn();
      results.push({ id, ...r, duration_ms: Date.now() - start });
    } catch (err) {
      results.push({
        id,
        status: "fail",
        detail: (err as Error).message,
        duration_ms: Date.now() - start,
      });
    }
    if (!json) {
      const r = results[results.length - 1];
      const mark = r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✗";
      console.log(`  ${mark} ${id.padEnd(20)} ${r.detail}`);
    }
  }

  if (!json) console.log(`\n  Nexaas conformance — workspace '${workspace}'\n`);

  // ── Infra proofs ────────────────────────────────────────────────────

  await check("palace-schema", async () => {
    const core = ["events", "wal", "skill_runs", "schema_migrations"];
    const r = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'nexaas_memory' AND table_name = ANY($1)`,
      [core],
    );
    const present = r.rows.map((row) => row.table_name as string);
    const missing = core.filter((t) => !present.includes(t));
    if (missing.length > 0) {
      return { status: "fail", detail: `nexaas_memory missing tables: ${missing.join(", ")}` };
    }
    return { status: "pass", detail: "nexaas_memory core tables present" };
  });

  await check("redis", async () => {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    try {
      await redis.connect();
      const pong = await redis.ping();
      redisHealthy = pong === "PONG";
      return redisHealthy
        ? { status: "pass", detail: "PONG" }
        : { status: "fail", detail: `unexpected ping reply: ${pong}` };
    } finally {
      redis.disconnect();
    }
  });

  await check("worker-health", async () => {
    try {
      const res = await fetch(`${workerBase()}/health`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { status?: string; uptime?: number };
      workerHealthy = res.ok && body.status === "healthy";
      return workerHealthy
        ? { status: "pass", detail: `healthy, uptime ${Math.round(body.uptime ?? 0)}s` }
        : { status: "fail", detail: `worker reports status='${body.status}' (http ${res.status})` };
    } catch (err) {
      return { status: "fail", detail: `no response from ${workerBase()}/health — is nexaas-worker running? (${(err as Error).message})` };
    }
  });

  await check("migration-state", async () => {
    const state = await gatherState();
    if (state.pending.length > 0) {
      return { status: "fail", detail: `${state.pending.length} pending migration(s): ${state.pending.join(", ")}` };
    }
    const residual = state.residual_public.table_exists
      ? ` (residual public.schema_migrations present — see nexaas migration-state)`
      : "";
    return { status: "pass", detail: `${state.applied_count} applied, 0 pending${residual}` };
  });

  await check("wal-chain", async () => {
    const r = await verifyWalChain(workspace);
    if (!r.valid) {
      return { status: "fail", detail: `WAL chain broken at id ${r.brokenAt}: ${r.error}` };
    }
    return { status: "pass", detail: "hash chain valid" };
  });

  // ── Execution proofs ────────────────────────────────────────────────

  const artifactsDir = mkdtempSync(join(tmpdir(), "nexaas-conformance-"));

  await check("shell-roundtrip", async () => {
    if (skipExecution) return { status: "skip", detail: "--skip-execution" };
    if (!workerHealthy || !redisHealthy) {
      return { status: "skip", detail: "requires live worker + redis" };
    }
    const manifestPath = join(artifactsDir, "shell-roundtrip.skill.yaml");
    writeFileSync(manifestPath, [
      `id: conformance/shell-roundtrip`,
      `version: "0.0.1"`,
      `description: Conformance probe — shell skill round-trip through the live worker`,
      `execution:`,
      `  type: shell`,
      `  command: "echo conformance-shell-ok"`,
      `  timeout: 30`,
      `rooms:`,
      `  primary: { wing: ops, hall: conformance, room: shell-roundtrip }`,
      ``,
    ].join("\n"));

    const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    const queue = new Queue(`nexaas-skills-${workspace}`, { connection });
    const runId = randomUUID();
    const jobId = `conformance-shell-${Date.now()}`;
    try {
      await queue.add("skill-step", {
        workspace,
        runId,
        skillId: "conformance/shell-roundtrip",
        skillVersion: "0.0.1",
        stepId: "shell-exec",
        triggerType: "manual",
        manifestPath,
      }, { jobId });

      const deadline = Date.now() + SHELL_ROUNDTRIP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const r = await pool.query(
          `SELECT status FROM nexaas_memory.skill_runs WHERE run_id = $1`,
          [runId],
        );
        const status = r.rows[0]?.status as string | undefined;
        if (status === "completed") {
          return { status: "pass", detail: `queue → worker → shell executor → skill_runs completed (run ${runId.slice(0, 8)})` };
        }
        if (status && status !== "running") {
          return { status: "fail", detail: `run finished with status='${status}' (run ${runId})` };
        }
        await sleep(POLL_INTERVAL_MS);
      }
      // Leave nothing behind on timeout.
      try { await (await queue.getJob(jobId))?.remove(); } catch { /* consumed or gone */ }
      return {
        status: "fail",
        detail: `no terminal status within ${SHELL_ROUNDTRIP_TIMEOUT_MS / 1000}s — worker not consuming nexaas-skills-${workspace}?`,
      };
    } finally {
      await queue.close();
      await connection.quit();
    }
  });

  await check("ai-pillar", async () => {
    if (skipExecution) return { status: "skip", detail: "--skip-execution" };

    const manifestPath = join(artifactsDir, "ai-pillar.skill.yaml");
    writeFileSync(manifestPath, [
      `id: conformance/ai-pillar`,
      `version: "0.0.1"`,
      `description: Conformance probe — ai-skill pillar pipeline against the mock model`,
      `execution:`,
      `  type: ai-skill`,
      `  model_tier: cheap`,
      `rooms:`,
      `  primary: { wing: ops, hall: conformance, room: ai-pillar }`,
      `limits:`,
      `  max_turns: 2`,
      `  max_spend_usd: 0.05`,
      ``,
    ].join("\n"));
    writeFileSync(join(artifactsDir, "prompt.md"), [
      `You are a conformance probe. Reply with a single short sentence and stop.`,
      ``,
    ].join("\n"));

    const mock = await startMockModelServer();
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = mock.url;
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = "conformance-mock-key";

    const runId = randomUUID();
    try {
      const { runAiSkill } = await import("@nexaas/runtime");
      const result = await runAiSkill(
        workspace,
        {
          id: "conformance/ai-pillar",
          version: "0.0.1",
          execution: { type: "ai-skill", model_tier: "cheap" },
          rooms: { primary: { wing: "ops", hall: "conformance", room: "ai-pillar" } },
          limits: { max_turns: 2, max_spend_usd: 0.05 },
        },
        manifestPath,
        { runId, stepId: "ai-exec", triggerType: "manual" },
      );

      if (!result.success) {
        return { status: "fail", detail: `runAiSkill returned success=false: ${result.content.slice(0, 200)}` };
      }
      if (mock.calls() === 0) {
        return { status: "fail", detail: "model call did not reach the mock server — ANTHROPIC_BASE_URL override not honored" };
      }
      if (!result.content.includes(MOCK_REPLY_TEXT.slice(0, 14))) {
        return { status: "fail", detail: `agentic loop returned unexpected content: ${result.content.slice(0, 120)}` };
      }
      const runRow = await pool.query(
        `SELECT status FROM nexaas_memory.skill_runs WHERE run_id = $1`,
        [runId],
      );
      if (runRow.rows[0]?.status !== "completed") {
        return { status: "fail", detail: `skill_runs status='${runRow.rows[0]?.status}' after successful run` };
      }
      const walRow = await pool.query(
        `SELECT count(*)::int AS n FROM nexaas_memory.wal
          WHERE workspace = $1 AND op = 'ai_skill_completed' AND payload->>'run_id' = $2`,
        [workspace, runId],
      );
      if ((walRow.rows[0]?.n ?? 0) < 1) {
        return { status: "fail", detail: "no ai_skill_completed WAL entry for the run" };
      }
      return {
        status: "pass",
        detail: `pillar pipeline + agentic loop + WAL audit in ${result.turns} turn(s), ${mock.calls()} mock model call(s)`,
      };
    } finally {
      if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
      await mock.close();
    }
  });

  await check("waitpoint-roundtrip", async () => {
    if (skipExecution) return { status: "skip", detail: "--skip-execution" };
    if (!workerHealthy) return { status: "skip", detail: "requires live worker" };

    const role = "conformance_probe";
    const code = String(100000 + Math.floor(Math.random() * 900000));

    const reg = await fetch(`${workerBase()}/api/waitpoints/inbound-match`, {
      method: "POST",
      headers: bearerHeaders(),
      body: JSON.stringify({
        workspace,
        match: { room_pattern: role, content_pattern: "digit_code" },
        timeout_seconds: 120,
        tags: ["conformance"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (reg.status !== 201) {
      return { status: "fail", detail: `waitpoint registration failed: http ${reg.status} ${(await reg.text()).slice(0, 150)}` };
    }
    const { waitpoint_id } = (await reg.json()) as { waitpoint_id: string };

    try {
      const post = await fetch(`${workerBase()}/api/drawers/inbound`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          workspace,
          channel_role: role,
          message: {
            id: `conformance-${waitpoint_id}`,
            from: "conformance",
            content: `conformance probe code ${code}`,
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (post.status !== 201) {
        return { status: "fail", detail: `inbound drawer write failed: http ${post.status} ${(await post.text()).slice(0, 150)}` };
      }

      const deadline = Date.now() + WAITPOINT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const res = await fetch(
          `${workerBase()}/api/waitpoints/${waitpoint_id}?workspace=${encodeURIComponent(workspace)}`,
          { headers: bearerHeaders(), signal: AbortSignal.timeout(5000) },
        );
        const status = (await res.json()) as {
          status?: string;
          resolved_with?: { content?: string };
        };
        if (status.status === "resolved") {
          const got = status.resolved_with?.content ?? "";
          return got.includes(code)
            ? { status: "pass", detail: `inbound drawer matched + extracted '${code}' via live worker` }
            : { status: "fail", detail: `resolved with unexpected content '${got}' (expected ${code})` };
        }
        if (status.status && status.status !== "pending") {
          return { status: "fail", detail: `waitpoint ended '${status.status}' before resolution` };
        }
        await sleep(POLL_INTERVAL_MS);
      }
      return {
        status: "fail",
        detail: `not resolved within ${WAITPOINT_TIMEOUT_MS / 1000}s — inbound-match matcher not running in the worker?`,
      };
    } finally {
      // Cancel if still pending so no waitpoint outlives the probe.
      try {
        await fetch(`${workerBase()}/api/waitpoints/${waitpoint_id}?workspace=${encodeURIComponent(workspace)}`, {
          method: "DELETE",
          headers: bearerHeaders(),
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* already resolved or worker gone */ }
    }
  });

  await check("backup-run", async () => {
    if (!withBackup) return { status: "skip", detail: "opt-in via --with-backup" };
    const before = await pool.query(`SELECT count(*)::int AS n FROM nexaas_memory.backup_history`);
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], "backup", "now"], {
      encoding: "utf-8",
      timeout: 300_000,
      env: process.env,
    });
    if (r.status !== 0) {
      return { status: "fail", detail: `nexaas backup now exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}` };
    }
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM nexaas_memory.backup_history`,
    );
    if ((after.rows[0]?.n ?? 0) <= (before.rows[0]?.n ?? 0)) {
      return { status: "fail", detail: "backup command succeeded but no backup_history row was recorded" };
    }
    return { status: "pass", detail: "backup ran and was recorded in backup_history (restore not exercised — see #213)" };
  });

  // ── Summary ─────────────────────────────────────────────────────────

  if (!keepArtifacts) rmSync(artifactsDir, { recursive: true, force: true });

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  // Persist the result for the fleet heartbeat (#216) — best-effort; a
  // pre-014 schema without workspace_kv must not fail the suite.
  try {
    await pool.query(
      `INSERT INTO nexaas_memory.workspace_kv (workspace, key, value) VALUES ($1, 'last_conformance', $2)
       ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value`,
      [workspace, JSON.stringify({
        at: new Date().toISOString(),
        passed,
        failed,
        skipped,
        failed_checks: results.filter((r) => r.status === "fail").map((r) => r.id),
      })],
    );
  } catch { /* workspace_kv absent — heartbeat reports conformance: null */ }

  await pool.end();

  if (json) {
    console.log(JSON.stringify({ workspace, results, summary: { passed, failed, skipped } }, null, 2));
  } else {
    console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (keepArtifacts) console.log(`  Artifacts kept at ${artifactsDir}`);
    console.log("");
  }

  process.exit(failed > 0 ? 1 : 0);
}
