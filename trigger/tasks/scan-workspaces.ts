/**
 * Scheduled SSH sweep of all client workspaces.
 *
 * Runs every 6 hours on the core. SSHes into each registered workspace,
 * pulls uncollected feedback signals, and feeds them into the pipeline.
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { query } from "../../orchestrator/db.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { createProposal } from "../../orchestrator/promotion/proposal-generator.js";
import { sanitize } from "../../orchestrator/feedback/sanitizer.js";
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
  queue: { name: "orchestrator", concurrencyLimit: 5 },
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

        // Process skill improvement signals through sanitizer → proposal generator
        const improvements = rows.filter((r: any) => r.signal === "skill_improvement" && r.claude_reflection);
        for (const imp of improvements) {
          try {
            // Sanitize the improvement description (strip client-specific data)
            const sanitized = await sanitize(imp.claude_reflection, imp.workspace_id);

            if (sanitized.status === "clean" || sanitized.cleanedText) {
              const cleanText = sanitized.cleanedText || imp.claude_reflection;
              const proposalId = await createProposal({
                skillId: imp.skill_id,
                workspaceId: imp.workspace_id,
                improvement: cleanText,
                type: "improvement",
                violations: sanitized.violations,
                pass1Clean: sanitized.pass1Result === "clean",
                pass2Clean: sanitized.pass2Result === "clean",
              });
              logger.info(`Created proposal #${proposalId} for ${imp.skill_id} from ${imp.workspace_id}`);
            } else {
              logger.warn(`Improvement from ${imp.workspace_id} for ${imp.skill_id} flagged by sanitizer — skipped`);
            }
          } catch (err) {
            logger.error(`Failed to create proposal for ${imp.skill_id}: ${err}`);
          }
        }

        // Process failure signals — check for cross-workspace correlation
        const failures = rows.filter((r: any) => r.signal === "execution_failure");
        if (failures.length > 0) {
          for (const fail of failures) {
            // Check if same skill failed on 2+ workspaces in last 24h
            const correlated = await query(
              `SELECT COUNT(DISTINCT workspace_id) as ws_count
               FROM skill_feedback
               WHERE skill_id = $1 AND signal = 'execution_failure'
               AND created_at > NOW() - INTERVAL '24 hours'`,
              [fail.skill_id]
            );
            const wsCount = (correlated.rows[0] as any)?.ws_count || 0;
            if (wsCount >= 2) {
              logger.warn(`Correlated failure: ${fail.skill_id} failing on ${wsCount} workspaces — triggering diagnosis`);
              // Import dynamically to avoid circular deps
              const { diagnoseFailure } = await import("./diagnose-failure.js");
              await diagnoseFailure.trigger({ skillId: fail.skill_id });
            }
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
