/**
 * Workspace manifest loader.
 *
 * Reads `<id>.workspace.json` from the configured directory and validates
 * it against the framework schema. Default path is
 * `/opt/nexmatic/workspaces/` — per docs/glossary.md, the framework does
 * not host tenant manifests. Override with NEXAAS_WORKSPACE_MANIFEST_DIR
 * for non-Nexmatic deployments or for testing.
 *
 * Fail-open behavior:
 *   - File missing   → returns `null` (pre-manifest workspaces continue running)
 *   - File malformed → returns `null` + logs error
 *   - Schema errors  → returns `null` + logs errors
 *   - Schema warns   → returns parsed manifest + logs warnings
 *
 * The framework never halts startup on a manifest issue. Operators see
 * warnings in the worker log and via the /health state payload.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { appendWal } from "@nexaas/palace";
import { validateManifest, type WorkspaceManifest } from "./workspace-manifest.js";

const DEFAULT_MANIFEST_DIR = "/opt/nexmatic/workspaces";

export function getManifestDir(): string {
  return process.env.NEXAAS_WORKSPACE_MANIFEST_DIR ?? DEFAULT_MANIFEST_DIR;
}

export interface LoadResult {
  manifest: WorkspaceManifest | null;
  warnings: string[];
  errors: string[];
}

/**
 * Load + validate the manifest for a workspace. Always returns — never
 * throws. Caller inspects the result and decides whether warnings warrant
 * a notification.
 */
export async function loadWorkspaceManifest(workspaceId: string): Promise<LoadResult> {
  const manifestDir = getManifestDir();
  const manifestPath = join(manifestDir, `${workspaceId}.workspace.json`);

  if (!existsSync(manifestPath)) {
    return {
      manifest: null,
      warnings: [
        `No manifest found at ${manifestPath}. Framework running with built-in defaults. ` +
        `Create one or set NEXAAS_WORKSPACE_MANIFEST_DIR.`,
      ],
      errors: [],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return {
      manifest: null,
      warnings: [],
      errors: [`Failed to parse ${manifestPath}: ${(err as Error).message}`],
    };
  }

  const { ok, manifest, warnings, errors } = validateManifest(raw);

  // Surface via WAL so operators can inspect history without tailing logs.
  // Best-effort — if the palace is down during startup we just skip this.
  if (warnings.length > 0 || errors.length > 0) {
    try {
      await appendWal({
        workspace: workspaceId,
        op: ok ? "manifest_loaded_with_warnings" : "manifest_load_failed",
        actor: "workspace-manifest-loader",
        payload: {
          path: manifestPath,
          warnings: warnings.slice(0, 20),
          errors: errors.slice(0, 20),
          manifest_version: manifest?.manifest_version,
        },
      });
    } catch { /* palace not ready or WAL disabled — non-fatal */ }
  }

  return {
    manifest: ok ? manifest ?? null : null,
    warnings,
    errors,
  };
}
