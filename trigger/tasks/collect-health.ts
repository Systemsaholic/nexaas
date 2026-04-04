/**
 * Periodic health collection from all workspace VPSes.
 *
 * SSHes into each VPS, collects RAM, disk, container status, and worker state.
 * Writes snapshots to ops_health_snapshots for the dashboard.
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

export const collectHealth = task({
  id: "collect-health",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 120,
  run: async (payload?: { workspaceId?: string }) => {
    const workspaceIds = payload?.workspaceId
      ? [payload.workspaceId]
      : getWorkspaceIds();

    logger.info(`Collecting health from ${workspaceIds.length} workspace(s)`);

    const results: Record<string, string> = {};

    for (const wsId of workspaceIds) {
      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          logger.info(`Skipping ${wsId} — no SSH config`);
          results[wsId] = "skipped";
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const target = `${user}@${host}`;
        const sshOpts = `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${port}`;

        // Collect all metrics in one SSH call
        const cmd = [
          "free -m | awk '/^Mem:/ {print $2,$3}'",
          "df -BG / | awk 'NR==2 {gsub(/G/,\"\"); print $2,$3}'",
          "docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | wc -l",
          "docker ps --format '{{.Status}}' 2>/dev/null | grep -c healthy || echo 0",
          "systemctl is-active nexaas-worker 2>/dev/null || echo inactive",
        ].join(" && echo '---' && ");

        const result = await runShell({
          command: `ssh ${sshOpts} ${target} "${cmd}"`,
          timeoutMs: 15000,
          label: `health-${wsId}`,
        });

        if (result.exitCode !== 0) {
          logger.warn(`SSH failed for ${wsId}: ${result.stderr}`);
          results[wsId] = "ssh-failed";
          continue;
        }

        const sections = result.stdout.split("---").map((s: string) => s.trim());
        const [ramTotal, ramUsed] = (sections[0] ?? "0 0").split(/\s+/).map(Number);
        const [diskTotal, diskUsed] = (sections[1] ?? "0 0").split(/\s+/).map(Number);
        const containerCount = parseInt(sections[2] ?? "0", 10);
        const containersHealthy = parseInt(sections[3] ?? "0", 10);
        const workerActive = (sections[4] ?? "inactive").trim() === "active";

        await query(
          `INSERT INTO ops_health_snapshots
           (workspace_id, ram_total_mb, ram_used_mb, disk_total_gb, disk_used_gb,
            container_count, containers_healthy, worker_active, vps_ip, snapshot_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [wsId, ramTotal, ramUsed, diskTotal, diskUsed,
           containerCount, containersHealthy, workerActive, manifest.network.privateIp]
        );

        logger.info(`${wsId}: RAM ${ramUsed}/${ramTotal}M, Disk ${diskUsed}/${diskTotal}G, ${containerCount} containers, worker=${workerActive}`);
        results[wsId] = "ok";
      } catch (e) {
        logger.error(`Error collecting health for ${wsId}: ${(e as Error).message}`);
        results[wsId] = "error";
      }
    }

    return results;
  },
});

// Run every 5 minutes
export const collectHealthSchedule = schedules.task({
  id: "collect-health-schedule",
  cron: "*/5 * * * *",
  run: async () => {
    const result = await collectHealth.triggerAndWait({});
    if (result.ok) {
      logger.info("Health collection complete", { results: result.output });
    } else {
      logger.error("Health collection failed", { error: result.error });
    }
  },
});
