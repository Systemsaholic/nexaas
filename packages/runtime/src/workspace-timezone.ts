/**
 * Workspace timezone resolution (#260) — the framework's canonical order:
 * workspace_config.timezone → NEXAAS_TIMEZONE → UTC. One helper so runtime
 * call sites (alert timestamps, the AI-skill runtime clock) can't each grow
 * their own client-flavored default. Cached per workspace for the process
 * lifetime; a timezone change takes effect on worker restart, which is fine
 * for every current caller.
 */

import { sql } from "@nexaas/palace";

const cache = new Map<string, string>();

export async function workspaceTimezone(workspace: string): Promise<string> {
  const hit = cache.get(workspace);
  if (hit) return hit;
  let tz: string;
  try {
    const rows = await sql<{ timezone: string }>(
      `SELECT timezone FROM nexaas_memory.workspace_config WHERE workspace = $1`,
      [workspace],
    );
    tz = rows[0]?.timezone || process.env.NEXAAS_TIMEZONE || "UTC";
  } catch {
    tz = process.env.NEXAAS_TIMEZONE || "UTC";
  }
  cache.set(workspace, tz);
  return tz;
}
