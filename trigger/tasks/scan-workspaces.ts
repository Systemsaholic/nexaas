/**
 * Scheduled SSH sweep of all client workspaces.
 *
 * Runs every 6 hours on the core. SSHes into each registered workspace,
 * pulls uncollected feedback signals, and feeds them into the pipeline.
 */

import { task, schedules, logger, tasks } from "@trigger.dev/sdk/v3";
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

export const scanWorkspaces = task({
  id: "scan-workspaces",
  queue: { name: "orchestrator", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async () => {
    const workspaceIds = getWorkspaceIds();
    logger.info(`Scanning ${workspaceIds.length} workspaces`);

    let totalPulled = 0;
    const errors: string[] = [];

    for (const wsId of workspaceIds) {
      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          logger.info(`Skipping ${wsId} — no SSH config`);
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const sshTarget = `${user}@${host}`;
        const sshPort = port || 22;

        // Query uncollected feedback on the client
        const pullResult = await runShell({
          command: `ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${sshTarget} "psql \\$DATABASE_URL -t -A -c \\"SELECT row_to_json(f) FROM (SELECT id, skill_id, workspace_id, signal, evidence, claude_reflection, proposed_improvement, created_at FROM skill_feedback WHERE collected = false ORDER BY created_at LIMIT 50) f\\""`,
          timeoutMs: 30_000,
        });

        if (!pullResult.success) {
          logger.warn(`SSH to ${wsId} failed: ${pullResult.stderr.slice(0, 200)}`);
          errors.push(`${wsId}: ${pullResult.stderr.slice(0, 100)}`);
          continue;
        }

        // Parse JSON rows from psql output
        const rows = pullResult.stdout
          .trim()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);

        if (rows.length === 0) {
          logger.info(`${wsId}: no uncollected feedback`);
          continue;
        }

        logger.info(`${wsId}: pulled ${rows.length} feedback signals`);

        // Insert into core DB
        for (const row of rows) {
          await query(
            `INSERT INTO skill_feedback
              (skill_id, workspace_id, session_id, signal, evidence, claude_reflection, proposed_improvement, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [
              row.skill_id,
              row.workspace_id,
              row.session_id || null,
              row.signal,
              typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence),
              row.claude_reflection || null,
              row.proposed_improvement || null,
              row.created_at,
            ]
          );
        }

        // Mark as collected on client
        const ids = rows.map((r: any) => r.id);
        await runShell({
          command: `ssh -p ${sshPort} -o ConnectTimeout=10 ${sshTarget} "psql \\$DATABASE_URL -c \\"UPDATE skill_feedback SET collected = true WHERE id IN (${ids.join(",")})\\""`,
          timeoutMs: 15_000,
        });

        totalPulled += rows.length;

        // Check for skill improvement signals and trigger proposals
        const improvements = rows.filter((r: any) => r.signal === "skill_improvement");
        if (improvements.length > 0) {
          for (const imp of improvements) {
            await tasks.trigger("check-approvals", {
              type: "improvement",
              skillId: imp.skill_id,
              workspaceId: imp.workspace_id,
              reflection: imp.claude_reflection,
            });
          }
        }
      } catch (err) {
        logger.error(`Error scanning ${wsId}: ${err}`);
        errors.push(`${wsId}: ${String(err).slice(0, 100)}`);
      }
    }

    logger.info(`Scan complete: ${totalPulled} signals pulled, ${errors.length} errors`);
    return { totalPulled, errors, workspacesScanned: workspaceIds.length };
  },
});

// Run every 6 hours
export const scanWorkspacesSchedule = schedules.task({
  id: "scan-workspaces-schedule",
  cron: "0 */6 * * *",
  maxDuration: 60,
  run: async () => {
    await scanWorkspaces.trigger();
  },
});
