/**
 * Pushes approved skill updates to subscribed workspaces via SSH + rsync.
 */

import { logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../../trigger/lib/shell.js";
import { query } from "../db.js";
import { loadManifest, clearManifestCache } from "../bootstrap/manifest-loader.js";
import { checkCompatibility } from "../promotion/dependency-checker.js";
import { resolveVersion } from "./version-router.js";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import yaml from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export interface SyncResult {
  skillId: string;
  version: string;
  synced: string[];
  skipped: string[];
  failed: Array<{ workspaceId: string; error: string }>;
}

export async function propagateSkill(
  skillId: string,
  proposedVersion: string
): Promise<SyncResult> {
  const compat = await checkCompatibility(skillId, proposedVersion);
  const skillDir = join(NEXAAS_ROOT, "skills", ...skillId.split("/"));

  const synced: string[] = [];
  const failed: SyncResult["failed"] = [];

  for (const ws of compat.compatible) {
    try {
      const manifest = await loadManifest(ws.workspaceId);
      if (!manifest.ssh) {
        failed.push({ workspaceId: ws.workspaceId, error: "no SSH config" });
        continue;
      }

      const version = await resolveVersion(ws.workspaceId, skillId, proposedVersion);
      if (version !== proposedVersion) {
        logger.info(`${ws.workspaceId} pinned to v${version}, skipping v${proposedVersion}`);
        continue;
      }

      const { host, user, port } = manifest.ssh;
      const sshPort = port || 22;
      const destPath = `/opt/nexaas/skills/${skillId.replace("/", "/")}`;

      const rsyncResult = await runShell({
        command: `rsync -av --delete -e "ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" "${skillDir}/" "${user}@${host}:${destPath}/"`,
        timeoutMs: 60_000,
      });

      if (!rsyncResult.success) {
        failed.push({ workspaceId: ws.workspaceId, error: rsyncResult.stderr.slice(0, 200) });
        continue;
      }

      // Deploy MCP server dependencies for this skill
      let manifestChanged = false;
      try {
        const contractPath = join(skillDir, "contract.yaml");
        if (existsSync(contractPath)) {
          const contractRaw = readFileSync(contractPath, "utf-8");
          const contract = yaml.load(contractRaw) as { mcp_servers?: string[] };
          const requiredMcp = contract.mcp_servers ?? [];

          // Load MCP registry for port info
          const mcpRegistryPath = join(NEXAAS_ROOT, "mcp", "_registry.yaml");
          const mcpRegistry = yaml.load(readFileSync(mcpRegistryPath, "utf-8")) as {
            servers: Array<{ id: string; defaultPort: number }>;
          };

          for (const mcpId of requiredMcp) {
            if (manifest.mcp && manifest.mcp[mcpId]) continue;

            const mcpEntry = mcpRegistry.servers.find((s) => s.id === mcpId);
            const configPath = join(NEXAAS_ROOT, "mcp", "configs", `${mcpId}.yaml`);
            if (!existsSync(configPath)) continue;

            // Rsync MCP config
            await runShell({
              command: `rsync -av -e "ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" "${configPath}" "${user}@${host}:/opt/nexaas/mcp/configs/${mcpId}.yaml"`,
              timeoutMs: 15000,
            });

            // Check for custom server
            const customDir = join(NEXAAS_ROOT, "mcp", "servers", mcpId);
            if (existsSync(join(customDir, "package.json"))) {
              await runShell({
                command: `ssh -p ${sshPort} -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p /opt/nexaas/mcp/servers/${mcpId}"`,
                timeoutMs: 10000,
              });
              await runShell({
                command: `rsync -av --delete --exclude node_modules --exclude dist -e "ssh -p ${sshPort} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" "${customDir}/" "${user}@${host}:/opt/nexaas/mcp/servers/${mcpId}/"`,
                timeoutMs: 30000,
              });
              await runShell({
                command: `ssh -p ${sshPort} -o StrictHostKeyChecking=no ${user}@${host} "cd /opt/nexaas/mcp/servers/${mcpId} && npm install --production=false && npm run build"`,
                timeoutMs: 120000,
              });
            }

            // Register in manifest
            if (!manifest.mcp) manifest.mcp = {};
            const port = mcpEntry?.defaultPort;
            manifest.mcp[mcpId] = port ? `http://localhost:${port}` : "stdio";
            manifestChanged = true;
          }

          // Ensure skill is in manifest
          if (!manifest.skills?.includes(skillId)) {
            if (!manifest.skills) manifest.skills = [];
            manifest.skills.push(skillId);
            manifestChanged = true;
          }
        }
      } catch (e) {
        logger.warn(`MCP deploy for ${skillId} on ${ws.workspaceId}: ${e}`);
      }

      // Sync updated manifest to VPS if changed
      if (manifestChanged) {
        const manifestPath = join(NEXAAS_ROOT, "workspaces", `${ws.workspaceId}.workspace.json`);
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        await runShell({
          command: `rsync -av "${manifestPath}" "${user}@${host}:/opt/nexaas/workspaces/${ws.workspaceId}.workspace.json"`,
          timeoutMs: 15000,
        });
        clearManifestCache();
      }

      await query(
        `INSERT INTO skill_versions (skill_id, version, status, manifest, promoted_at)
         VALUES ($1, $2, 'stable', $3, NOW())
         ON CONFLICT (skill_id, version) DO NOTHING`,
        [skillId, proposedVersion, JSON.stringify({ workspaceId: ws.workspaceId })]
      );

      synced.push(ws.workspaceId);
      logger.info(`Synced ${skillId} v${proposedVersion} to ${ws.workspaceId}`);
    } catch (err) {
      failed.push({ workspaceId: ws.workspaceId, error: String(err).slice(0, 200) });
    }
  }

  return {
    skillId,
    version: proposedVersion,
    synced,
    skipped: compat.incompatible.map((w) => w.workspaceId),
    failed,
  };
}

export async function commitSkillUpdate(
  skillId: string,
  version: string
): Promise<boolean> {
  const result = await runShell({
    command: `cd "${NEXAAS_ROOT}" && git add skills/ && git diff --cached --quiet || git commit -m "promote: ${skillId} v${version}"`,
    cwd: NEXAAS_ROOT,
    timeoutMs: 30_000,
  });

  if (result.success) {
    const pushResult = await runShell({
      command: `cd "${NEXAAS_ROOT}" && git push`,
      cwd: NEXAAS_ROOT,
      timeoutMs: 30_000,
    });
    return pushResult.success;
  }

  return false;
}
