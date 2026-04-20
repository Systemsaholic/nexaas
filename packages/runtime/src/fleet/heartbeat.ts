/**
 * Fleet heartbeat — reports framework version + worker state to the
 * central Nexmatic ops dashboard so operators can see what's running
 * on every client VPS.
 *
 * Local side:
 *   - Reads VERSION file + `git rev-parse HEAD/abbrev-ref` at startup
 *   - Maintains a single-row state in `nexaas_memory.framework_heartbeat`
 *   - Logs every push attempt to the WAL
 *
 * Remote side (Nexmatic ops-console — implemented separately):
 *   - POST ${NEXAAS_FLEET_ENDPOINT}/heartbeat with Bearer token
 *   - Body: { workspace, version, commit_sha, branch, hostname, started_at, now, worker_status }
 *
 * Environment:
 *   NEXAAS_FLEET_ENDPOINT   base URL (e.g. https://nexmatic.ca/api/fleet)
 *   NEXAAS_FLEET_TOKEN      workspace-scoped bearer token
 *   NEXAAS_ROOT             path to framework install (default /opt/nexaas)
 *
 * If endpoint/token are missing, the module maintains the local state row
 * only — remote push is skipped silently. This keeps backwards compat for
 * installs that aren't yet wired to the fleet dashboard.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { hostname } from "os";
import { appendWal, sql } from "@nexaas/palace";

const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_HTTP_TIMEOUT_MS = 10_000;

export interface FrameworkIdentity {
  workspace: string;
  version: string;
  commit_sha: string | null;
  branch: string | null;
  hostname: string;
  started_at: string;
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

  _identity = {
    workspace,
    version,
    commit_sha,
    branch,
    hostname: hostname(),
    started_at: new Date().toISOString(),
  };
  return _identity;
}

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

async function pushRemote(identity: FrameworkIdentity): Promise<{ status: string; httpCode: number | null }> {
  const endpoint = process.env.NEXAAS_FLEET_ENDPOINT;
  const token = process.env.NEXAAS_FLEET_TOKEN;
  if (!endpoint || !token) {
    return { status: "skipped:unconfigured", httpCode: null };
  }

  const url = endpoint.replace(/\/$/, "") + "/heartbeat";
  const body = {
    workspace: identity.workspace,
    version: identity.version,
    commit_sha: identity.commit_sha,
    branch: identity.branch,
    hostname: identity.hostname,
    started_at: identity.started_at,
    now: new Date().toISOString(),
    worker_status: "running",
  };

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
