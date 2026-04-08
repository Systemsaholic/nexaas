/**
 * Periodic memory stats collection from all workspace VPSes.
 *
 * SSHes into each VPS, queries nexaas_memory.* tables, and writes
 * snapshots to memory_snapshots for the dashboard.
 *
 * Runs hourly — memory counts don't change fast enough to need more frequent polling.
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { query } from "../../orchestrator/db.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { readdirSync } from "fs";
import { join } from "path";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

function getWorkspaceIds(): string[] {
  const dir = join(NEXAAS_ROOT, "workspaces");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

function parseIntSafe(s: string | undefined, fallback = 0): number {
  if (!s) return fallback;
  const n = parseInt(s.trim(), 10);
  return isNaN(n) ? fallback : n;
}

function parseJsonSafe(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s.trim());
  } catch {
    return {};
  }
}

function parseTimestampSafe(s: string | undefined): string | null {
  const trimmed = (s ?? "").trim();
  if (!trimmed) return null;
  return trimmed;
}

export const collectMemoryStats = task({
  id: "collect-memory-stats",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 180,
  run: async (payload?: { workspaceId?: string }) => {
    const workspaceIds = payload?.workspaceId
      ? [payload.workspaceId]
      : getWorkspaceIds();

    logger.info(`Collecting memory stats from ${workspaceIds.length} workspace(s)`);

    const results: Record<string, string> = {};

    for (const wsId of workspaceIds) {
      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          results[wsId] = "skipped";
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const target = `${user}@${host}`;
        const sshOpts = `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${port}`;

        // Sync script to VPS
        await runShell({
          command: `scp -o StrictHostKeyChecking=accept-new -P ${port} ${NEXAAS_ROOT}/scripts/memory-stats-collect.sh ${target}:/opt/nexaas/scripts/memory-stats-collect.sh`,
          timeoutMs: 10000,
        });

        // Execute with DATABASE_URL from instance env
        const result = await runShell({
          command: `ssh ${sshOpts} ${target} "source /opt/nexaas/.env 2>/dev/null; bash /opt/nexaas/scripts/memory-stats-collect.sh"`,
          timeoutMs: 15000,
        });

        if (result.exitCode !== 0) {
          logger.warn(`SSH failed for ${wsId}: ${result.stderr.slice(0, 200)}`);
          results[wsId] = "ssh-failed";
          continue;
        }

        const sections = result.stdout.split("---").map((s: string) => s.trim());

        const eventCount = parseIntSafe(sections[0]);
        const entityCount = parseIntSafe(sections[1]);
        const factCount = parseIntSafe(sections[2]);
        const relationCount = parseIntSafe(sections[3]);
        const journalEntries = parseIntSafe(sections[4]);
        const embeddingLag = parseIntSafe(sections[5]);
        const events24h = parseIntSafe(sections[6]);
        const typeBreakdown = parseJsonSafe(sections[7]);
        const oldestEvent = parseTimestampSafe(sections[8]);
        const newestEvent = parseTimestampSafe(sections[9]);

        await query(
          `INSERT INTO memory_snapshots
           (workspace_id, event_count, entity_count, active_fact_count, relation_count,
            active_journal_entries, embedding_lag, events_24h, event_type_breakdown,
            oldest_event, newest_event, snapshot_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
          [
            wsId, eventCount, entityCount, factCount, relationCount,
            journalEntries, embeddingLag, events24h,
            JSON.stringify(typeBreakdown), oldestEvent, newestEvent,
          ]
        );

        logger.info(
          `${wsId}: ${eventCount} events, ${entityCount} entities, ${factCount} facts, ` +
          `${relationCount} relations, lag=${embeddingLag}, 24h=${events24h}`
        );
        results[wsId] = "ok";
      } catch (e) {
        logger.error(`Error collecting memory stats for ${wsId}: ${(e as Error).message}`);
        results[wsId] = "error";
      }
    }

    return results;
  },
});

// Run hourly
export const collectMemoryStatsSchedule = schedules.task({
  id: "collect-memory-stats-schedule",
  cron: "15 * * * *",
  run: async () => {
    const result = await collectMemoryStats.triggerAndWait({});
    if (result.ok) {
      logger.info("Memory stats collection complete", { results: result.output });
    } else {
      logger.error("Memory stats collection failed", { error: result.error });
    }
  },
});
