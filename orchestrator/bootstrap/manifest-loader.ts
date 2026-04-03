/**
 * Workspace manifest loader.
 *
 * Reads workspace manifests from:
 * - Development: {repoRoot}/workspaces/{id}.workspace.json
 * - Production:  {NEXAAS_ROOT}/workspaces/{id}.workspace.json
 */

import { readFileSync } from "fs";
import { join } from "path";

export interface WorkspaceManifest {
  id: string;
  name: string;
  workspaceRoot: string;
  claudeMd: {
    full: string;
    summary: string;
    minimal: string;
  };
  skills: string[];
  agents: string[];
  mcp: Record<string, string>;
  capabilities: Record<string, boolean>;
  trigger: {
    projectId: string;
    workerUrl: string;
  };
  domainMap?: Record<string, string>;
  context?: {
    threadTtlDays?: number;
    maxTurnsBeforeSummary?: number;
  };
}

const manifestCache = new Map<string, WorkspaceManifest>();

function getManifestDir(): string {
  const nexaasRoot = process.env.NEXAAS_ROOT;
  if (nexaasRoot) return join(nexaasRoot, "workspaces");
  // Development fallback: look relative to cwd
  return join(process.cwd(), "workspaces");
}

export async function loadManifest(workspaceId: string): Promise<WorkspaceManifest> {
  const cached = manifestCache.get(workspaceId);
  if (cached) return cached;

  const manifestPath = join(getManifestDir(), `${workspaceId}.workspace.json`);
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: WorkspaceManifest = JSON.parse(raw);

  if (manifest.id !== workspaceId) {
    throw new Error(`Manifest ID mismatch: expected "${workspaceId}", got "${manifest.id}"`);
  }

  manifestCache.set(workspaceId, manifest);
  return manifest;
}

export function clearManifestCache(): void {
  manifestCache.clear();
}
