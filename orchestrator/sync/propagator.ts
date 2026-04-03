/**
 * Pushes approved skill updates to subscribed workspaces via SSH + rsync.
 */

import { logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../../trigger/lib/shell.js";
import { query } from "../db.js";
import { loadManifest } from "../bootstrap/manifest-loader.js";
import { checkCompatibility } from "../promotion/dependency-checker.js";
import { resolveVersion } from "./version-router.js";
import { join } from "path";

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
