/**
 * Workspace manifest loader.
 *
 * Reads workspace manifests from:
 * - Development: {repoRoot}/workspaces/{id}.workspace.json
 * - Production:  {NEXAAS_ROOT}/workspaces/{id}.workspace.json
 */

import { readFileSync } from "fs";
import { join } from "path";
import { query } from "../db.js";

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
  network?: {
    privateIp: string;   // VLAN IP (e.g., 10.10.0.11) — used for SSH + inter-VPS
    publicIp?: string;   // Public IP (e.g., 15.235.40.168) — for external webhooks
  };
  ssh?: {
    host: string;        // Should be the privateIp for VLAN setups
    user: string;
    port?: number;
  };
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

async function ensureWorkspace(manifest: WorkspaceManifest): Promise<void> {
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
  const cached = manifestCache.get(workspaceId);
  if (cached) return cached;

  const manifestPath = join(getManifestDir(), `${workspaceId}.workspace.json`);
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: WorkspaceManifest = JSON.parse(raw);

  if (manifest.id !== workspaceId) {
    throw new Error(`Manifest ID mismatch: expected "${workspaceId}", got "${manifest.id}"`);
  }

  await ensureWorkspace(manifest);
  manifestCache.set(workspaceId, manifest);
  return manifest;
}

export function clearManifestCache(): void {
  manifestCache.clear();
}
