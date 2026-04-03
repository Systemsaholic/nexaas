/**
 * MCP server resolver.
 *
 * Given a workspace manifest and optional skill ID, returns the list of
 * MCP server names that should be loaded for this task.
 *
 * If a skill ID is provided, reads skills/_registry.yaml to get the
 * skill's MCP requirements and intersects with the workspace's available
 * MCP servers.
 *
 * If no skill ID, returns all MCP server names from the workspace manifest.
 */

import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { WorkspaceManifest } from "./manifest-loader.js";

interface SkillRegistryEntry {
  id: string;
  mcp?: string[];
}

interface SkillRegistry {
  version: string;
  skills: SkillRegistryEntry[];
}

let _skillRegistry: SkillRegistry | null = null;

function loadSkillRegistry(): SkillRegistry {
  if (_skillRegistry) return _skillRegistry;

  const nexaasRoot = process.env.NEXAAS_ROOT || process.cwd();
  const registryPath = join(nexaasRoot, "skills", "_registry.yaml");

  try {
    const raw = readFileSync(registryPath, "utf-8");
    _skillRegistry = yaml.load(raw) as SkillRegistry;
  } catch {
    _skillRegistry = { version: "2.0", skills: [] };
  }

  return _skillRegistry;
}

export function resolveMcpServers(
  manifest: WorkspaceManifest,
  skillId?: string
): string[] {
  const availableServers = Object.keys(manifest.mcp);

  if (!skillId) return availableServers;

  const registry = loadSkillRegistry();
  const skill = registry.skills.find((s) => s.id === skillId);

  if (!skill || !skill.mcp || skill.mcp.length === 0) {
    return availableServers;
  }

  // Intersect: only MCP servers the skill needs AND the workspace has
  return skill.mcp.filter((s) => availableServers.includes(s));
}
