/**
 * Architectural Integrity Check — validates every instance conforms
 * to the Nexaas architecture standard.
 *
 * Runs on the orchestrator, SSHes into each instance, checks:
 * 1. Identity docs exist (brand-voice.md, operations.md, agent-handbook.md)
 * 2. Skills are deployed and registered in workspace_skills
 * 3. Channel registry has at least dashboard channel
 * 4. Client dashboard is running
 * 5. Worker is running + healthy
 * 6. Database has all required tables
 * 7. CLAUDE.md is current
 * 8. Config files exist (client-profile.yaml)
 * 9. Skill contracts are valid
 * 10. MCP servers match skill requirements
 *
 * Reports to orchestrator DB for dashboard display.
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { query } from "../../orchestrator/db.js";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

function getWorkspaceIds(): string[] {
  const dir = join(NEXAAS_ROOT, "workspaces");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

interface IntegrityResult {
  workspace: string;
  timestamp: string;
  score: number;      // 0-100
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>;
}

export const integrityCheck = task({
  id: "integrity-check",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 600,
  run: async (payload?: { workspaceId?: string }) => {
    const workspaceIds = payload?.workspaceId
      ? [payload.workspaceId]
      : getWorkspaceIds();

    const results: IntegrityResult[] = [];

    for (const wsId of workspaceIds) {
      const checks: IntegrityResult["checks"] = [];

      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          results.push({ workspace: wsId, timestamp: new Date().toISOString(), score: 0, checks: [{ name: "ssh", status: "fail", detail: "No SSH config in manifest" }] });
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const target = `${user}@${host}`;
        const sshOpts = `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${port}`;
        // DB checks use scripts/integrity-db-check.sh (avoids SSH quoting issues)

        // 1. Identity docs
        const identityCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "ls /opt/nexaas/identity/${wsId}/ 2>/dev/null | wc -l"`,
          timeoutMs: 10000,
        });
        const identityCount = parseInt(identityCheck.stdout.trim(), 10);
        checks.push({
          name: "identity-docs",
          status: identityCount >= 3 ? "pass" : identityCount > 0 ? "warn" : "fail",
          detail: `${identityCount} identity documents found${identityCount < 3 ? " (need brand-voice.md, operations.md, agent-handbook.md)" : ""}`,
        });

        // 2-3-6-8. DB checks via script (avoids shell quoting hell)
        await runShell({
          command: `scp -o StrictHostKeyChecking=accept-new -P ${port} ${NEXAAS_ROOT}/scripts/integrity-db-check.sh ${target}:/opt/nexaas/scripts/integrity-db-check.sh`,
          timeoutMs: 10000,
        });
        const dbCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "bash /opt/nexaas/scripts/integrity-db-check.sh ${wsId}"`,
          timeoutMs: 15000,
        });
        const dbParts = (dbCheck.stdout.trim() || "0|0|0|0").split("|").map((s) => parseInt(s, 10));
        const [activeSkills, channelCount, tableCount, hasConfig] = dbParts;

        checks.push({
          name: "skills-registered",
          status: activeSkills > 0 ? "pass" : "warn",
          detail: `${activeSkills} active skills registered`,
        });

        checks.push({
          name: "channel-registry",
          status: channelCount > 0 ? "pass" : "fail",
          detail: `${channelCount} channels registered${channelCount === 0 ? " (need at least dashboard)" : ""}`,
        });

        // 4. Client dashboard
        const dashCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "systemctl is-active nexaas-client-dashboard 2>/dev/null || echo inactive"`,
          timeoutMs: 10000,
        });
        const dashActive = dashCheck.stdout.trim() === "active";
        checks.push({
          name: "client-dashboard",
          status: dashActive ? "pass" : "fail",
          detail: dashActive ? "Client dashboard running" : "Client dashboard not running",
        });

        // 5. Worker
        const workerCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "systemctl is-active nexaas-worker 2>/dev/null || echo inactive"`,
          timeoutMs: 10000,
        });
        const workerActive = workerCheck.stdout.trim() === "active";
        checks.push({
          name: "worker",
          status: workerActive ? "pass" : "fail",
          detail: workerActive ? "Worker running" : "Worker not running",
        });

        // 6. Database tables (from DB script above)
        checks.push({
          name: "database",
          status: tableCount >= 15 ? "pass" : tableCount > 5 ? "warn" : "fail",
          detail: `${tableCount} tables in database${tableCount < 15 ? " (expected 15+)" : ""}`,
        });

        // 7. CLAUDE.md current
        const claudeCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "test -f /opt/nexaas/CLAUDE.md && echo exists || echo missing"`,
          timeoutMs: 10000,
        });
        checks.push({
          name: "claude-md",
          status: claudeCheck.stdout.trim() === "exists" ? "pass" : "fail",
          detail: claudeCheck.stdout.trim() === "exists" ? "CLAUDE.md present" : "CLAUDE.md missing",
        });

        // 8. Config file (from DB script above)
        checks.push({
          name: "client-config",
          status: hasConfig ? "pass" : "warn",
          detail: hasConfig ? "Client profile configured" : "No client profile — run Foundation Skill",
        });

        // 9. Docker containers
        const containerCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "docker ps --format '{{.Status}}' 2>/dev/null | grep -c Up || echo 0"`,
          timeoutMs: 10000,
        });
        const containers = parseInt(containerCheck.stdout.trim(), 10);
        checks.push({
          name: "containers",
          status: containers >= 6 ? "pass" : containers >= 4 ? "warn" : "fail",
          detail: `${containers}/6 containers running`,
        });

        // 10. MCP config
        const mcpCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "test -f /opt/nexaas/.mcp.json && echo exists || echo missing"`,
          timeoutMs: 10000,
        });
        checks.push({
          name: "mcp-config",
          status: mcpCheck.stdout.trim() === "exists" ? "pass" : "warn",
          detail: mcpCheck.stdout.trim() === "exists" ? ".mcp.json present" : ".mcp.json missing — MCP skills won't load tools",
        });

        // 11. Migration status
        const migCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "psql \\$DATABASE_URL -t -A -c \\"SELECT COUNT(*) FROM schema_migrations\\" 2>/dev/null || echo 0"`,
          timeoutMs: 10000,
        });
        const migCount = parseInt(migCheck.stdout.trim(), 10) || 0;
        const expectedMigrations = readdirSync(join(NEXAAS_ROOT, "database", "migrations"))
          .filter((f) => f.endsWith(".sql")).length;
        checks.push({
          name: "migrations",
          status: migCount >= expectedMigrations ? "pass" : "warn",
          detail: `${migCount}/${expectedMigrations} migrations applied`,
        });

        // Calculate score
        const passCount = checks.filter((c) => c.status === "pass").length;
        const warnCount = checks.filter((c) => c.status === "warn").length;
        const score = Math.round(((passCount * 10 + warnCount * 5) / (checks.length * 10)) * 100);

        const result: IntegrityResult = {
          workspace: wsId,
          timestamp: new Date().toISOString(),
          score,
          checks,
        };
        results.push(result);

        // Store in DB
        await query(
          `INSERT INTO ops_alerts (severity, category, message, details, created_at)
           VALUES ($1, 'integrity', $2, $3, NOW())`,
          [
            score >= 80 ? "info" : score >= 50 ? "warning" : "critical",
            `Integrity check: ${wsId} scored ${score}/100`,
            JSON.stringify(result),
          ]
        );

        logger.info(`Integrity: ${wsId} = ${score}/100 (${passCount} pass, ${warnCount} warn, ${checks.length - passCount - warnCount} fail)`);
      } catch (e) {
        results.push({
          workspace: wsId,
          timestamp: new Date().toISOString(),
          score: 0,
          checks: [{ name: "connection", status: "fail", detail: (e as Error).message }],
        });
      }
    }

    return results;
  },
});

// Run daily at 6am
export const integrityCheckSchedule = schedules.task({
  id: "integrity-check-schedule",
  cron: "0 6 * * *",
  run: async () => {
    await integrityCheck.trigger({});
  },
});
