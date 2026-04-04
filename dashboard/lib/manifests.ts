import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceManifest } from "./types";

const WORKSPACES_DIR = join(process.env.NEXAAS_ROOT ?? "/opt/nexaas", "workspaces");

export async function getWorkspaceIds(): Promise<string[]> {
  const files = await readdir(WORKSPACES_DIR);
  return files
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

export async function loadManifest(workspaceId: string): Promise<WorkspaceManifest> {
  const filePath = join(WORKSPACES_DIR, `${workspaceId}.workspace.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as WorkspaceManifest;
}

export async function loadAllManifests(): Promise<WorkspaceManifest[]> {
  const ids = await getWorkspaceIds();
  return Promise.all(ids.map(loadManifest));
}
