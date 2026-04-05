import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { query } from "./db";
import type { WorkspaceManifest } from "./types";

const execAsync = promisify(execFile);
const WORKSPACES_DIR = join(process.env.NEXAAS_ROOT ?? "/opt/nexaas", "workspaces");

export async function getWorkspaceIds(): Promise<string[]> {
  const files = await readdir(WORKSPACES_DIR);
  return files
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

/**
 * Upsert a workspace row from its manifest so FK references always resolve.
 * Fire-and-forget safe — errors are swallowed to avoid breaking read paths.
 */
export async function ensureWorkspace(manifest: WorkspaceManifest): Promise<void> {
  try {
    await query(
      `INSERT INTO workspaces (id, name, workspace_root, manifest)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         manifest = EXCLUDED.manifest,
         last_seen_at = NOW()`,
      [manifest.id, manifest.name, manifest.workspaceRoot, JSON.stringify(manifest)]
    );
  } catch {
    // Non-fatal — DB may be unreachable during bootstrap or dev
  }
}

export async function loadManifest(workspaceId: string): Promise<WorkspaceManifest> {
  const filePath = join(WORKSPACES_DIR, `${workspaceId}.workspace.json`);
  const raw = await readFile(filePath, "utf-8");
  const manifest = JSON.parse(raw) as WorkspaceManifest;
  await ensureWorkspace(manifest);
  return manifest;
}

export async function saveManifest(manifest: WorkspaceManifest): Promise<void> {
  const filePath = join(WORKSPACES_DIR, `${manifest.id}.workspace.json`);
  await writeFile(filePath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  await ensureWorkspace(manifest);
}

export async function rsyncManifestToVps(manifest: WorkspaceManifest): Promise<void> {
  if (!manifest.ssh) throw new Error("No SSH config on manifest");
  const { host, user, port } = manifest.ssh;
  const filePath = join(WORKSPACES_DIR, `${manifest.id}.workspace.json`);
  await execAsync("rsync", [
    "-av",
    "-e", `ssh -p ${port || 22} -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new`,
    filePath,
    `${user}@${host}:/opt/nexaas/workspaces/${manifest.id}.workspace.json`,
  ], { timeout: 15000 });
}

export async function loadAllManifests(): Promise<WorkspaceManifest[]> {
  const ids = await getWorkspaceIds();
  return Promise.all(ids.map(loadManifest));
}
