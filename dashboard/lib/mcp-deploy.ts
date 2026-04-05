import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import YAML from "js-yaml";
import { loadMcpRegistry, type McpServer } from "./integrations";
import { sshExec } from "./ssh";
import type { WorkspaceManifest } from "./types";

const execAsync = promisify(execFile);
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export interface McpDeployResult {
  deployed: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Read a skill's contract.yaml and return its MCP server requirements.
 */
export async function getSkillMcpRequirements(skillId: string): Promise<string[]> {
  const [category, name] = skillId.split("/");
  const contractPath = join(NEXAAS_ROOT, "skills", category, name, "contract.yaml");
  try {
    const raw = await readFile(contractPath, "utf-8");
    const contract = YAML.load(raw) as { mcp_servers?: string[] };
    return contract.mcp_servers ?? [];
  } catch {
    return [];
  }
}

/**
 * Check if an MCP server has a custom implementation in mcp/servers/{id}/.
 */
async function isCustomServer(mcpId: string): Promise<boolean> {
  try {
    await stat(join(NEXAAS_ROOT, "mcp", "servers", mcpId, "package.json"));
    return true;
  } catch {
    return false;
  }
}

function sshArgs(manifest: WorkspaceManifest): string {
  const port = manifest.ssh.port || 22;
  return `ssh -p ${port} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new`;
}

function sshTarget(manifest: WorkspaceManifest): string {
  return `${manifest.ssh.user}@${manifest.ssh.host}`;
}

/**
 * Deploy all MCP servers required by a skill to a workspace VPS.
 * Returns which servers were deployed, skipped (already present), or errored.
 *
 * Does NOT modify the manifest — caller is responsible for updating
 * manifest.mcp with deployed server IDs and saving.
 */
export async function deployMcpServersForSkill(
  manifest: WorkspaceManifest,
  skillId: string
): Promise<McpDeployResult> {
  const requiredMcpIds = await getSkillMcpRequirements(skillId);
  if (requiredMcpIds.length === 0) return { deployed: [], skipped: [], errors: [] };

  const registry = await loadMcpRegistry();
  const deployed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  if (!manifest.ssh) {
    return { deployed: [], skipped: [], errors: ["No SSH config on manifest"] };
  }

  const target = sshTarget(manifest);
  const sshFlag = sshArgs(manifest);

  for (const mcpId of requiredMcpIds) {
    // Skip if already registered in manifest
    if (manifest.mcp[mcpId]) {
      skipped.push(mcpId);
      continue;
    }

    const entry = registry.find((s) => s.id === mcpId);
    if (!entry) {
      errors.push(`MCP server "${mcpId}" not found in registry`);
      continue;
    }

    try {
      // 1. Ensure config directory exists on VPS
      await sshExec(manifest, "mkdir -p /opt/nexaas/mcp/configs", 10000);

      // 2. Rsync the config YAML
      const configPath = join(NEXAAS_ROOT, "mcp", "configs", `${mcpId}.yaml`);
      await execAsync("rsync", [
        "-av", "-e", sshFlag,
        configPath,
        `${target}:/opt/nexaas/mcp/configs/${mcpId}.yaml`,
      ], { timeout: 15000 });

      // 3. If custom server, rsync source + build on VPS
      if (await isCustomServer(mcpId)) {
        const customDir = join(NEXAAS_ROOT, "mcp", "servers", mcpId);

        await sshExec(manifest, `mkdir -p /opt/nexaas/mcp/servers/${mcpId}`, 10000);

        await execAsync("rsync", [
          "-av", "--delete",
          "--exclude", "node_modules",
          "--exclude", "dist",
          "-e", sshFlag,
          `${customDir}/`,
          `${target}:/opt/nexaas/mcp/servers/${mcpId}/`,
        ], { timeout: 30000 });

        // npm install + build on VPS (up to 2 min)
        await sshExec(
          manifest,
          `cd /opt/nexaas/mcp/servers/${mcpId} && npm install --production=false && npm run build`,
          120000
        );
      }

      // 4. Sync the MCP registry to VPS
      await execAsync("rsync", [
        "-av", "-e", sshFlag,
        join(NEXAAS_ROOT, "mcp", "_registry.yaml"),
        `${target}:/opt/nexaas/mcp/_registry.yaml`,
      ], { timeout: 15000 });

      deployed.push(mcpId);
    } catch (e) {
      errors.push(`MCP "${mcpId}": ${(e as Error).message}`);
    }
  }

  return { deployed, skipped, errors };
}

/**
 * Look up the default port for an MCP server ID from the registry.
 */
export async function getMcpDefaultPort(mcpId: string): Promise<number | null> {
  const registry = await loadMcpRegistry();
  const entry = registry.find((s) => s.id === mcpId);
  return entry?.defaultPort ?? null;
}
