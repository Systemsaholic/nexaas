/**
 * Skill manifest lookup helper (shared by inbound-dispatcher, approval-resolver,
 * and any future caller that needs to resolve a skill_id to a manifest path).
 *
 * Walks `${NEXAAS_WORKSPACE_ROOT}/nexaas-skills/` via the shared
 * @nexaas/manifest walker and caches the (id → path, execType) map with a
 * short TTL.
 */

import { join } from "path";
import { loadManifest, findManifestPaths } from "@nexaas/manifest";

interface SkillIndexEntry {
  skillId: string;
  manifestPath: string;
  execType: string;   // "ai-exec" | "shell-exec"
}

interface CachedIndex {
  byId: Map<string, SkillIndexEntry>;
  builtAt: number;
}

let _cached: CachedIndex | null = null;
const INDEX_TTL_MS = 30_000;

function buildIndex(skillsRoot: string): CachedIndex {
  const byId = new Map<string, SkillIndexEntry>();
  for (const manifestPath of findManifestPaths(skillsRoot)) {
    try {
      const manifest = loadManifest(manifestPath);
      if (typeof manifest.id !== "string") continue;
      const execType = manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec";
      byId.set(manifest.id, { skillId: manifest.id, manifestPath, execType });
    } catch {
      // Malformed manifest — skip silently. Scheduler self-heal logs these
      // at startup; no need to re-warn on every index refresh.
    }
  }
  return { byId, builtAt: Date.now() };
}

export function findSkillManifest(skillId: string): SkillIndexEntry | null {
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  if (!workspaceRoot) return null;

  const now = Date.now();
  if (!_cached || now - _cached.builtAt >= INDEX_TTL_MS) {
    _cached = buildIndex(join(workspaceRoot, "nexaas-skills"));
  }
  return _cached.byId.get(skillId) ?? null;
}

/** Invalidate the cache — call on skill register/unregister if we want
 *  immediate freshness. Framework code can tolerate 30s staleness. */
export function invalidateSkillManifestIndex(): void {
  _cached = null;
}
