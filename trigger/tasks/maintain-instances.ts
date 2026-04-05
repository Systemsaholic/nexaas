/**
 * Periodic instance maintenance.
 *
 * Sweeps all instances and ensures Claude Code, CLAUDE.md, skills,
 * and configs are up to date. Runs every hour.
 *
 * Checks per instance:
 * 1. Claude Code installed and current version
 * 2. CLAUDE.md matches current template
 * 3. Deployed skills match orchestrator versions
 * 4. Worker is running
 * 5. Trigger.dev containers healthy
 */

import { task, schedules, logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { query } from "../../orchestrator/db.js";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createHash } from "crypto";
import yaml from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

function getWorkspaceIds(): string[] {
  const dir = join(NEXAAS_ROOT, "workspaces");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

export const maintainInstances = task({
  id: "maintain-instances",
  queue: { name: "orchestrator", concurrencyLimit: 5 },
  maxDuration: 600,
  run: async () => {
    const workspaceIds = getWorkspaceIds();
    logger.info(`Maintaining ${workspaceIds.length} instances`);

    const results: Record<string, Record<string, string>> = {};

    for (const wsId of workspaceIds) {
      const checks: Record<string, string> = {};

      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          checks.status = "skipped — no SSH config";
          results[wsId] = checks;
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const target = `${user}@${host}`;
        const sshOpts = `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${port}`;

        // 1. Check Claude Code installed
        const claudeCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "command -v claude && claude --version 2>/dev/null || echo 'not-installed'"`,
          timeoutMs: 15000,
          label: `claude-check-${wsId}`,
        });

        const claudeOutput = claudeCheck.stdout.trim();
        if (claudeOutput.includes("not-installed")) {
          // Install Claude Code
          logger.info(`Installing Claude Code on ${wsId}`);
          await runShell({
            command: `ssh ${sshOpts} ${target} "curl -fsSL https://claude.ai/install.sh | sh"`,
            timeoutMs: 120000,
            label: `claude-install-${wsId}`,
          });
          checks.claude = "installed";
        } else {
          checks.claude = claudeOutput.split("\n").pop() || "ok";
        }

        // 2. Update CLAUDE.md from template
        try {
          const template = readFileSync(join(NEXAAS_ROOT, "templates", "instance-CLAUDE.md"), "utf-8");
          const rendered = template
            .replace(/\{\{WORKSPACE_ID\}\}/g, wsId)
            .replace(/\{\{WORKSPACE_NAME\}\}/g, manifest.name || wsId)
            .replace(/\{\{PRIVATE_IP\}\}/g, manifest.network?.privateIp || host);

          // Check if CLAUDE.md needs updating
          const currentMd = await runShell({
            command: `ssh ${sshOpts} ${target} "md5sum /opt/nexaas/CLAUDE.md 2>/dev/null || echo 'missing'"`,
            timeoutMs: 10000,
            label: `claudemd-check-${wsId}`,
          });

          // Compute local hash of rendered template
          const crypto = await import("crypto");
          const renderedHash = crypto.createHash("md5").update(rendered).digest("hex");
          const remoteHash = currentMd.stdout.trim().split(" ")[0];

          if (remoteHash === "missing" || remoteHash !== renderedHash) {
            // Push updated CLAUDE.md
            execSync(
              `ssh ${sshOpts} ${target} 'cat > /opt/nexaas/CLAUDE.md' << 'CLAUDEEOF'\n${rendered}\nCLAUDEEOF`,
              { timeout: 15000 }
            );
            checks.claudeMd = "updated";
          } else {
            checks.claudeMd = "current";
          }
        } catch (e) {
          checks.claudeMd = `error: ${(e as Error).message}`;
        }

        // 3. Check deployed skills are in sync + auto-register
        const subscribedSkills = await query(
          `SELECT skill_id FROM workspace_skills WHERE workspace_id = $1`,
          [wsId]
        );
        const registeredSkillIds = new Set(subscribedSkills.rows.map((r: any) => r.skill_id));

        // Find all skills on the orchestrator from the registry
        try {
          const registryRaw = readFileSync(join(NEXAAS_ROOT, "skills", "_registry.yaml"), "utf-8");
          const registry = yaml.load(registryRaw) as { skills: Array<{ id: string; status: string }> };
          const activeSkills = (registry.skills ?? []).filter((s) => s.status === "active");

          for (const skill of activeSkills) {
            const skillId = skill.id;
            const [category, name] = skillId.split("/");
            const localPath = join(NEXAAS_ROOT, "skills", category, name, "contract.yaml");

            if (!existsSync(localPath)) continue;

            try {
              const localHash = execSync(`md5sum ${localPath} 2>/dev/null`, { timeout: 5000 })
                .toString().trim().split(" ")[0];

              const remoteCheck = await runShell({
                command: `ssh ${sshOpts} ${target} "md5sum /opt/nexaas/skills/${category}/${name}/contract.yaml 2>/dev/null || echo 'missing'"`,
                timeoutMs: 10000,
                label: `skill-check-${wsId}-${skillId}`,
              });

              const remoteHash = remoteCheck.stdout.trim().split(" ")[0];

              if (remoteHash === "missing") {
                execSync(
                  `rsync -av ${NEXAAS_ROOT}/skills/${category}/${name}/ ${target}:/opt/nexaas/skills/${category}/${name}/`,
                  { timeout: 30000 }
                );
                checks[`skill:${skillId}`] = "synced (was missing)";
              } else if (remoteHash !== localHash) {
                execSync(
                  `rsync -av ${NEXAAS_ROOT}/skills/${category}/${name}/ ${target}:/opt/nexaas/skills/${category}/${name}/`,
                  { timeout: 30000 }
                );
                checks[`skill:${skillId}`] = "synced (was outdated)";
              } else {
                checks[`skill:${skillId}`] = "current";
              }

              // Auto-register in workspace_skills if not already registered
              if (!registeredSkillIds.has(skillId)) {
                // Register on orchestrator DB
                await query(
                  `INSERT INTO workspace_skills (workspace_id, skill_id, active)
                   VALUES ($1, $2, true)
                   ON CONFLICT (workspace_id, skill_id) DO NOTHING`,
                  [wsId, skillId]
                );
                // Register on instance DB
                await runShell({
                  command: `ssh ${sshOpts} ${target} "psql \\$DATABASE_URL -c \\"INSERT INTO workspace_skills (workspace_id, skill_id, active) VALUES ('${wsId}', '${skillId}', true) ON CONFLICT (workspace_id, skill_id) DO NOTHING\\""`,
                  timeoutMs: 10000,
                  label: `skill-register-${wsId}-${skillId}`,
                });
                checks[`skill:${skillId}`] += " + registered";
              }
            } catch (e) {
              checks[`skill:${skillId}`] = `error: ${(e as Error).message}`;
            }
          }
        } catch (e) {
          checks.skillRegistry = `error reading registry: ${(e as Error).message}`;
        }

        // 4. Check MCP configs are in sync
        const allRequiredMcp = new Set<string>();
        for (const row of subscribedSkills.rows) {
          const sid = (row as { skill_id: string }).skill_id;
          const [cat, nm] = sid.split("/");
          try {
            const contractRaw = readFileSync(
              join(NEXAAS_ROOT, "skills", cat, nm, "contract.yaml"), "utf-8"
            );
            const contract = yaml.load(contractRaw) as { mcp_servers?: string[] };
            for (const mcpId of contract.mcp_servers ?? []) {
              allRequiredMcp.add(mcpId);
            }
          } catch { /* skill may not have contract */ }
        }

        for (const mcpId of allRequiredMcp) {
          const localConfig = join(NEXAAS_ROOT, "mcp", "configs", `${mcpId}.yaml`);
          if (!existsSync(localConfig)) continue;

          try {
            const localHash = execSync(`md5sum ${localConfig}`, { timeout: 5000 })
              .toString().trim().split(" ")[0];

            const remoteCheck = await runShell({
              command: `ssh ${sshOpts} ${target} "md5sum /opt/nexaas/mcp/configs/${mcpId}.yaml 2>/dev/null || echo 'missing'"`,
              timeoutMs: 10000,
              label: `mcp-check-${wsId}-${mcpId}`,
            });

            const remoteHash = remoteCheck.stdout.trim().split(" ")[0];
            if (remoteHash === "missing" || remoteHash !== localHash) {
              execSync(
                `rsync -av -e "ssh ${sshOpts.replace(/-o /g, '-o ')}" ${localConfig} ${target}:/opt/nexaas/mcp/configs/${mcpId}.yaml`,
                { timeout: 15000 }
              );
              checks[`mcp:${mcpId}`] = remoteHash === "missing" ? "synced (was missing)" : "synced (was outdated)";
            } else {
              checks[`mcp:${mcpId}`] = "current";
            }
          } catch (e) {
            checks[`mcp:${mcpId}`] = `error: ${(e as Error).message}`;
          }
        }

        // 5. Verify workspace manifest on VPS matches orchestrator
        try {
          const localManifestJson = JSON.stringify(manifest);
          const localManifestHash = createHash("md5").update(localManifestJson).digest("hex");

          const remoteManifestCheck = await runShell({
            command: `ssh ${sshOpts} ${target} "md5sum /opt/nexaas/workspaces/${wsId}.workspace.json 2>/dev/null || echo 'missing'"`,
            timeoutMs: 10000,
            label: `manifest-check-${wsId}`,
          });

          const remoteManifestHash = remoteManifestCheck.stdout.trim().split(" ")[0];
          if (remoteManifestHash === "missing" || remoteManifestHash !== localManifestHash) {
            execSync(
              `rsync -av ${NEXAAS_ROOT}/workspaces/${wsId}.workspace.json ${target}:/opt/nexaas/workspaces/${wsId}.workspace.json`,
              { timeout: 15000 }
            );
            checks.manifest = "synced";
          } else {
            checks.manifest = "current";
          }
        } catch (e) {
          checks.manifest = `error: ${(e as Error).message}`;
        }

        // 6. Check worker status
        const workerCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "systemctl is-active nexaas-worker 2>/dev/null || echo 'inactive'"`,
          timeoutMs: 10000,
          label: `worker-check-${wsId}`,
        });
        const workerStatus = workerCheck.stdout.trim();
        checks.worker = workerStatus;

        if (workerStatus !== "active") {
          // Try to restart
          logger.warn(`Worker down on ${wsId}, attempting restart`);
          await runShell({
            command: `ssh ${sshOpts} ${target} "sudo systemctl restart nexaas-worker 2>&1"`,
            timeoutMs: 20000,
            label: `worker-restart-${wsId}`,
          });
          checks.worker = "restarted";
        }

        // 7. Check containers
        const containerCheck = await runShell({
          command: `ssh ${sshOpts} ${target} "docker ps --format '{{.Status}}' 2>/dev/null | wc -l"`,
          timeoutMs: 10000,
          label: `container-check-${wsId}`,
        });
        const containerCount = parseInt(containerCheck.stdout.trim(), 10);
        checks.containers = `${containerCount} running`;

        if (containerCount < 6) {
          logger.warn(`Only ${containerCount}/6 containers on ${wsId}`);
          checks.containers = `${containerCount}/6 — degraded`;
        }

        // Record last maintenance
        await query(
          `INSERT INTO ops_health_snapshots
           (workspace_id, worker_active, container_count, containers_healthy, vps_ip, snapshot_at)
           VALUES ($1, $2, $3, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [wsId, workerStatus === "active" || workerStatus === "restarted", containerCount, manifest.network?.privateIp || host]
        );

      } catch (e) {
        checks.error = (e as Error).message;
        logger.error(`Maintenance failed for ${wsId}: ${checks.error}`);
      }

      results[wsId] = checks;
      logger.info(`${wsId}: ${JSON.stringify(checks)}`);
    }

    return results;
  },
});

// Run every hour
export const maintainInstancesSchedule = schedules.task({
  id: "maintain-instances-schedule",
  cron: "0 * * * *",
  run: async () => {
    const result = await maintainInstances.triggerAndWait({});
    if (result.ok) {
      logger.info("Instance maintenance complete", { results: result.output });
    } else {
      logger.error("Instance maintenance failed", { error: result.error });
    }
  },
});
