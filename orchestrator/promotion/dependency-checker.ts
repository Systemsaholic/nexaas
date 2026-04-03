/**
 * Checks workspace compatibility for a skill update.
 * Ensures subscribed workspaces have required MCP servers and capabilities.
 */

import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { loadManifest, type WorkspaceManifest } from "../bootstrap/manifest-loader.js";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

export interface CompatibilityReport {
  skillId: string;
  proposedVersion: string;
  compatible: Array<{ workspaceId: string; name: string }>;
  incompatible: Array<{ workspaceId: string; name: string; missing: string[] }>;
}

interface SkillRequirements {
  mcp?: string[];
  capabilities?: Record<string, boolean>;
}

function loadSkillRequirements(skillId: string): SkillRequirements {
  try {
    const skillPath = join(NEXAAS_ROOT, "skills", ...skillId.split("/"), "skill.yaml");
    const raw = readFileSync(skillPath, "utf-8");
    const skill = yaml.load(raw) as any;
    return {
      mcp: skill?.resources?.mcp || [],
      capabilities: {},
    };
  } catch {
    return { mcp: [], capabilities: {} };
  }
}

function getSubscribedWorkspaceIds(skillId: string): string[] {
  try {
    const registryPath = join(NEXAAS_ROOT, "skills", "_registry.yaml");
    const raw = readFileSync(registryPath, "utf-8");
    const registry = yaml.load(raw) as { skills: Array<{ id: string; workspaces: string[] }> };
    const skill = registry.skills.find((s) => s.id === skillId);
    return skill?.workspaces || [];
  } catch {
    return [];
  }
}

export async function checkCompatibility(
  skillId: string,
  proposedVersion: string
): Promise<CompatibilityReport> {
  const requirements = loadSkillRequirements(skillId);
  const subscribedIds = getSubscribedWorkspaceIds(skillId);

  const compatible: CompatibilityReport["compatible"] = [];
  const incompatible: CompatibilityReport["incompatible"] = [];

  for (const wsId of subscribedIds) {
    try {
      const manifest = await loadManifest(wsId);
      const missing: string[] = [];

      const availableMcp = Object.keys(manifest.mcp);
      for (const required of requirements.mcp || []) {
        if (!availableMcp.includes(required)) {
          missing.push(`mcp:${required}`);
        }
      }

      for (const [cap, needed] of Object.entries(requirements.capabilities || {})) {
        if (needed && !manifest.capabilities[cap]) {
          missing.push(`capability:${cap}`);
        }
      }

      if (missing.length === 0) {
        compatible.push({ workspaceId: wsId, name: manifest.name });
      } else {
        incompatible.push({ workspaceId: wsId, name: manifest.name, missing });
      }
    } catch {
      incompatible.push({ workspaceId: wsId, name: wsId, missing: ["manifest-not-found"] });
    }
  }

  return { skillId, proposedVersion, compatible, incompatible };
}
