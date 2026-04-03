/**
 * Version pinning resolution.
 *
 * Checks if a workspace has a pinned version for a skill.
 * If pinned, returns that version. Otherwise returns "latest".
 */

import { queryOne } from "../db.js";

export async function resolveVersion(
  workspaceId: string,
  skillId: string,
  latestVersion: string
): Promise<string> {
  const pin = await queryOne(
    `SELECT pinned_version FROM workspace_skills
     WHERE workspace_id = $1 AND skill_id = $2 AND active = true`,
    [workspaceId, skillId]
  );

  if (pin?.pinned_version) {
    return pin.pinned_version as string;
  }

  return latestVersion;
}
