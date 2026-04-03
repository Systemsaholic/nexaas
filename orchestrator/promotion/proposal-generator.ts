/**
 * Creates structured skill proposals from feedback signals.
 * Determines version bump (minor for improvements, patch for fixes).
 */

import { query } from "../db.js";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();

interface SkillRegistryEntry {
  id: string;
  version: string;
  status: string;
  workspaces: string[];
}

function loadSkillVersion(skillId: string): string {
  try {
    const registryPath = join(NEXAAS_ROOT, "skills", "_registry.yaml");
    const raw = readFileSync(registryPath, "utf-8");
    const registry = yaml.load(raw) as { skills: SkillRegistryEntry[] };
    const skill = registry.skills.find((s) => s.id === skillId);
    return skill?.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function bumpVersion(version: string, type: "minor" | "patch"): string {
  const parts = version.split(".").map(Number);
  if (type === "minor") {
    parts[1] = (parts[1] || 0) + 1;
    parts[2] = 0;
  } else {
    parts[2] = (parts[2] || 0) + 1;
  }
  return parts.join(".");
}

export async function createProposal(params: {
  skillId: string;
  workspaceId: string;
  improvement: string;
  type: "improvement" | "fix";
  violations?: unknown[];
  pass1Clean?: boolean;
  pass2Clean?: boolean;
}): Promise<number> {
  const currentVersion = loadSkillVersion(params.skillId);
  const bumpType = params.type === "fix" ? "patch" : "minor";
  const proposedVersion = bumpVersion(currentVersion, bumpType);

  const result = await query(
    `INSERT INTO skill_proposals
      (skill_id, workspace_id, from_version, proposed_version,
       proposed_improvement, status, violations, pass1_clean, pass2_clean, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, NOW())
     RETURNING id`,
    [
      params.skillId,
      params.workspaceId,
      currentVersion,
      proposedVersion,
      params.improvement,
      params.violations ? JSON.stringify(params.violations) : null,
      params.pass1Clean ?? null,
      params.pass2Clean ?? null,
    ]
  );

  return result.rows[0].id as number;
}
