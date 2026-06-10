/**
 * Fleet heartbeat — reports framework version + workspace health to the
 * central ops dashboard so a solo operator can see what's running on every
 * client VPS without SSHing into any of them.
 *
 * Local side:
 *   - Reads VERSION file + git identity at startup
 *   - Maintains a single-row state in `nexaas_memory.framework_heartbeat`
 *   - Logs every push attempt to the WAL
 *
 * Remote side (receiver contract: docs/fleet-heartbeat-contract.md):
 *   - POST ${NEXAAS_FLEET_ENDPOINT}/heartbeat — payload v3 (#216): identity
 *     + release channel (#214) + 24h error rates + daily spend/budget state
 *     (#215) + pending migrations + last conformance result (#213) + queue
 *     depths. Every v3 collector is best-effort: a broken collector nulls
 *     its field, it never blocks the beat.
 *   - POST ${NEXAAS_FLEET_ENDPOINT}/events — escalated events (page/digest)
 *     via pushFleetEvent(). Used by the silent-failure watchdog (#69) and
 *     the spend-budget monitor (#215) so fleet ops hears about a workspace
 *     even when that workspace's own channel bindings are broken.
 *
 * Environment:
 *   NEXAAS_FLEET_ENDPOINT   base URL (e.g. https://nexmatic.ca/api/fleet)
 *   NEXAAS_FLEET_TOKEN      workspace-scoped bearer token
 *   NEXAAS_ROOT             path to framework install (default /opt/nexaas)
 *
 * If endpoint/token are missing, the module maintains the local state row
 * only — remote push (and pushFleetEvent) is a silent no-op. Direct
 * adopters see zero behavior change.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { hostname } from "os";
import { appendWal, sql, sqlOne } from "@nexaas/palace";
import { getBudgetState } from "../models/spend-governor.js";
import { getSkillQueue } from "../bullmq/queues.js";

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_HTTP_TIMEOUT_MS = 10_000;

export interface FrameworkIdentity {
  workspace: string;
  version: string;
  commit_sha: string | null;
  branch: string | null;
  /** `git describe --tags --always` — the release-aware version (#214). */
  describe: string | null;
  hostname: string;
  started_at: string;
}

export interface FleetEvent {
  /** Stable event type, e.g. "silent_failure", "spend_budget_exceeded". */
  type: string;
  /** "page" = wake a human; "digest" = batch into the daily rollup. */
  severity: "page" | "digest";
  title: string;
  body: string;
  /** Receiver-side de-dupe key. */
  dedupe_key?: string;
  /** Structured extras for the dashboard. */
  data?: Record<string, unknown>;
}

let _identity: FrameworkIdentity | null = null;
let _timer: NodeJS.Timeout | null = null;

function exec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .trim() || null;
  } catch {
    return null;
  }
}

function fleetConfig(): { endpoint: string; token: string } | null {
  const endpoint = process.env.NEXAAS_FLEET_ENDPOINT;
  const token = process.env.NEXAAS_FLEET_TOKEN;
  if (!endpoint || !token) return null;
  return { endpoint: endpoint.replace(/\/$/, ""), token };
}

export function isFleetConfigured(): boolean {
  return fleetConfig() !== null;
}

export function getFrameworkIdentity(): FrameworkIdentity {
  if (_identity) return _identity;

  const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
  const workspace = process.env.NEXAAS_WORKSPACE ?? "unknown";

  let version = "0.0.0";
  try {
    version = readFileSync(join(nexaasRoot, "VERSION"), "utf-8").trim() || "0.0.0";
  } catch { /* VERSION file missing — keep default */ }

  const commit_sha = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`);
  const branch = exec(`git -C ${nexaasRoot} rev-parse --abbrev-ref HEAD`);
  const describe = exec(`git -C ${nexaasRoot} describe --tags --always`);

  _identity = {
    workspace,
    version,
    commit_sha,
    branch,
    describe,
    hostname: hostname(),
    started_at: new Date().toISOString(),
  };
  return _identity;
}

// ── v3 collectors ─────────────────────────────────────────────────────
// Each returns null on any failure. The heartbeat is the operator's last
// line of sight into a degraded VPS — a collector hitting the exact
// breakage being reported must not take the whole beat down with it.

async function collectChannel(workspace: string): Promise<string | null> {
  try {
    const row = await sqlOne<{ value: string }>(
      `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'framework_channel'`,
      [workspace],
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function collectRuns24h(workspace: string): Promise<{
  completed: number;
  failed: number;
  skipped: number;
  success_rate_pct: number | null;
} | null> {
  try {
    const row = await sqlOne<{ completed: string; failed: string; skipped: string }>(
      `SELECT count(*) FILTER (WHERE status = 'completed') AS completed,
              count(*) FILTER (WHERE status = 'failed') AS failed,
              count(*) FILTER (WHERE status = 'skipped') AS skipped
         FROM nexaas_memory.skill_runs
        WHERE workspace = $1 AND started_at > now() - interval '24 hours'`,
      [workspace],
    );
    const completed = Number(row?.completed ?? 0);
    const failed = Number(row?.failed ?? 0);
    const skipped = Number(row?.skipped ?? 0);
    const terminal = completed + failed;
    return {
      completed,
      failed,
      skipped,
      success_rate_pct: terminal > 0 ? Math.round((100 * completed) / terminal) : null,
    };
  } catch {
    return null;
  }
}

async function collectSpend(workspace: string): Promise<{
  day: string;
  spent_usd: number;
  budget_usd: number | null;
  paused: boolean;
} | null> {
  try {
    const state = await getBudgetState(workspace);
    let paused = false;
    try {
      const marker = await sqlOne<{ value: string }>(
        `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'spend_pause_active_day'`,
        [workspace],
      );
      paused = marker?.value === state.day;
    } catch { /* kv missing */ }
    return { day: state.day, spent_usd: state.spentUsd, budget_usd: state.budgetUsd, paused };
  } catch {
    return null;
  }
}

async function collectMigrations(workspace: string): Promise<{
  applied: number;
  pending: number;
} | null> {
  void workspace;
  try {
    const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const onDisk = readdirSync(join(nexaasRoot, "database", "migrations"))
      .filter((f) => f.endsWith(".sql"));
    const rows = await sql<{ filename: string }>(
      `SELECT filename FROM nexaas_memory.schema_migrations`,
    );
    const applied = new Set(rows.map((r) => r.filename));
    const pending = onDisk.filter((f) => !applied.has(f)).length;
    return { applied: applied.size, pending };
  } catch {
    return null;
  }
}

async function collectConformance(workspace: string): Promise<Record<string, unknown> | null> {
  try {
    const row = await sqlOne<{ value: string }>(
      `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'last_conformance'`,
      [workspace],
    );
    return row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function collectQueue(workspace: string): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  paused: boolean;
} | null> {
  try {
    const queue = getSkillQueue(workspace);
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    const paused = await queue.isPaused();
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      paused,
    };
  } catch {
    return null;
  }
}

async function buildPayloadV3(identity: FrameworkIdentity): Promise<Record<string, unknown>> {
  const [channel, runs_24h, spend, migrations, conformance, queue] = await Promise.all([
    collectChannel(identity.workspace),
    collectRuns24h(identity.workspace),
    collectSpend(identity.workspace),
    collectMigrations(identity.workspace),
    collectConformance(identity.workspace),
    collectQueue(identity.workspace),
  ]);

  return {
    payload_version: 3,
    workspace: identity.workspace,
    version: identity.version,
    commit_sha: identity.commit_sha,
    branch: identity.branch,
    describe: identity.describe,
    channel,
    hostname: identity.hostname,
    started_at: identity.started_at,
    now: new Date().toISOString(),
    worker_status: "running",
    uptime_s: Math.round(process.uptime()),
    runs_24h,
    spend,
    migrations,
    conformance,
    queue,
  };
}

// ── local state + push ────────────────────────────────────────────────

async function upsertLocalState(
  identity: FrameworkIdentity,
  push: { status: string; httpCode: number | null } | null,
): Promise<void> {
  try {
    await sql(
      `INSERT INTO nexaas_memory.framework_heartbeat
        (workspace, version, commit_sha, branch, hostname, started_at, last_push_at, last_push_status, last_push_http, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (workspace) DO UPDATE SET
         version = EXCLUDED.version,
         commit_sha = EXCLUDED.commit_sha,
         branch = EXCLUDED.branch,
         hostname = EXCLUDED.hostname,
         last_push_at = EXCLUDED.last_push_at,
         last_push_status = EXCLUDED.last_push_status,
         last_push_http = EXCLUDED.last_push_http,
         updated_at = now()`,
      [
        identity.workspace,
        identity.version,
        identity.commit_sha,
        identity.branch,
        identity.hostname,
        identity.started_at,
        push ? new Date().toISOString() : null,
        push?.status ?? null,
        push?.httpCode ?? null,
      ],
    );
  } catch (err) {
    // Heartbeat must never crash the worker. Log and move on.
    console.error("[nexaas] failed to upsert framework_heartbeat:", err);
  }
}

async function postJson(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: string; httpCode: number | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEARTBEAT_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return { status: "ok", httpCode: res.status };
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { status: `failed:http_${res.status}:${detail}`.slice(0, 200), httpCode: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: `failed:${msg}`.slice(0, 200), httpCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function pushRemote(identity: FrameworkIdentity): Promise<{ status: string; httpCode: number | null }> {
  const config = fleetConfig();
  if (!config) {
    return { status: "skipped:unconfigured", httpCode: null };
  }
  const payload = await buildPayloadV3(identity);
  return postJson(`${config.endpoint}/heartbeat`, config.token, payload);
}

export async function pushHeartbeat(): Promise<void> {
  const identity = getFrameworkIdentity();
  const push = await pushRemote(identity);
  await upsertLocalState(identity, push);

  // WAL op: distinguish success, genuine failure, and "fleet dashboard not
  // configured on this install" (no-op, not a failure). The third case is
  // the common state for installs not yet wired to a central ops dashboard;
  // logging it as a failure creates false-positive noise in alerts.
  let op = "framework_heartbeat_sent";
  if (push.status === "ok") op = "framework_heartbeat_sent";
  else if (push.status.startsWith("skipped:")) op = "framework_heartbeat_skipped";
  else op = "framework_heartbeat_failed";

  await appendWal({
    workspace: identity.workspace,
    op,
    actor: "fleet-heartbeat",
    payload: {
      version: identity.version,
      commit_sha: identity.commit_sha,
      status: push.status,
      http_code: push.httpCode,
    },
  });
}

/**
 * Escalate an event to the fleet receiver (#216). Silent no-op when the
 * fleet endpoint isn't configured (direct adopters), so callers don't need
 * to gate on configuration. Never throws.
 *
 * This is the path that works precisely when the workspace's own channel
 * bindings don't — e.g. the silent-failure watchdog escalating "this
 * workspace can't deliver its own alerts".
 */
export async function pushFleetEvent(workspace: string, event: FleetEvent): Promise<void> {
  const config = fleetConfig();
  if (!config) return;

  const identity = getFrameworkIdentity();
  const result = await postJson(`${config.endpoint}/events`, config.token, {
    payload_version: 3,
    workspace,
    hostname: identity.hostname,
    at: new Date().toISOString(),
    ...event,
  });

  try {
    await appendWal({
      workspace,
      op: result.status === "ok" ? "fleet_event_sent" : "fleet_event_failed",
      actor: "fleet-heartbeat",
      payload: {
        type: event.type,
        severity: event.severity,
        dedupe_key: event.dedupe_key,
        status: result.status,
        http_code: result.httpCode,
      },
    });
  } catch (err) {
    console.error("[nexaas] fleet event WAL append failed:", err);
  }
}

export function startHeartbeatLoop(): void {
  if (_timer) return;
  // First push ASAP so startup is visible to the dashboard.
  void pushHeartbeat();
  _timer = setInterval(() => { void pushHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
  _timer.unref?.();
}

export function stopHeartbeatLoop(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
