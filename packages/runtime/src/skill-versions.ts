/**
 * Skill versioning runtime — multi-version loading, version pinning, deprecation.
 *
 * Skills are versioned via semver in their manifests. The runtime can:
 * - Load a specific version of a skill from the library
 * - Pin a workspace to a specific skill version
 * - Track version history per workspace
 * - Deprecate old versions with grace period
 */

import { sql, appendWal } from "@nexaas/palace";

export interface SkillVersion {
  skillId: string;
  version: string;
  status: "active" | "deprecated" | "retired";
  files: Record<string, string>;
  contributedAt: string;
}

export async function getSkillVersion(
  workspace: string,
  skillId: string,
  requestedVersion?: string,
): Promise<SkillVersion | null> {
  // Check for workspace-level version pin
  if (!requestedVersion) {
    const pin = await sql<{ value: string }>(
      `SELECT value FROM nexaas_memory.workspace_kv
       WHERE workspace = $1 AND key = $2`,
      [workspace, `skill_pin:${skillId}`],
    );
    if (pin.length > 0) requestedVersion = pin[0].value;
  }

  let query: string;
  let params: unknown[];

  if (requestedVersion) {
    query = `
      SELECT content FROM nexaas_memory.events
      WHERE wing = 'library' AND hall = 'skills' AND room = $1
        AND event_type = 'skill-registration'
        AND content::jsonb->>'version' = $2
      ORDER BY created_at DESC LIMIT 1`;
    params = [skillId, requestedVersion];
  } else {
    query = `
      SELECT content FROM nexaas_memory.events
      WHERE wing = 'library' AND hall = 'skills' AND room = $1
        AND event_type = 'skill-registration'
      ORDER BY created_at DESC LIMIT 1`;
    params = [skillId];
  }

  const rows = await sql<{ content: string }>(query, params);
  if (rows.length === 0) return null;

  const data = JSON.parse(rows[0].content);
  return {
    skillId: data.id,
    version: data.version,
    status: "active",
    files: data.files ?? {},
    contributedAt: data.contributed_at,
  };
}

export async function pinSkillVersion(
  workspace: string,
  skillId: string,
  version: string,
): Promise<void> {
  await sql(
    `INSERT INTO nexaas_memory.workspace_kv (workspace, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace, key) DO UPDATE SET value = $3`,
    [workspace, `skill_pin:${skillId}`, version],
  );

  await appendWal({
    workspace,
    op: "skill_version_pinned",
    actor: "runtime",
    payload: { skill_id: skillId, version },
  });
}

export async function unpinSkillVersion(
  workspace: string,
  skillId: string,
): Promise<void> {
  await sql(
    `DELETE FROM nexaas_memory.workspace_kv
     WHERE workspace = $1 AND key = $2`,
    [workspace, `skill_pin:${skillId}`],
  );
}

export async function listSkillVersions(
  skillId: string,
): Promise<Array<{ version: string; contributedAt: string; isCanonical: boolean }>> {
  const versions = await sql<{ content: string; created_at: string }>(
    `SELECT content, created_at::text
     FROM nexaas_memory.events
     WHERE wing = 'library' AND hall = 'skills' AND room = $1
       AND event_type = 'skill-registration'
     ORDER BY created_at DESC`,
    [skillId],
  );

  const canonical = await sql<{ content_hash: string }>(
    `SELECT content_hash FROM nexaas_memory.events
     WHERE wing = 'library' AND hall = 'canonical' AND room = $1
     ORDER BY created_at DESC LIMIT 1`,
    [skillId],
  );

  const canonicalVersions = new Set(
    canonical.map(c => {
      try { return JSON.parse(c.content_hash).version; } catch { return ""; }
    }),
  );

  const seen = new Set<string>();
  const results: Array<{ version: string; contributedAt: string; isCanonical: boolean }> = [];

  for (const row of versions) {
    const data = JSON.parse(row.content);
    if (seen.has(data.version)) continue;
    seen.add(data.version);

    results.push({
      version: data.version,
      contributedAt: row.created_at,
      isCanonical: canonicalVersions.has(data.version),
    });
  }

  return results;
}

export async function getVersionHistory(
  workspace: string,
  skillId: string,
  limit = 20,
): Promise<Array<{ version: string; runCount: number; lastRun: string; avgTurns: number }>> {
  const history = await sql<{
    skill_version: string;
    run_count: string;
    last_run: string;
    avg_turns: string;
  }>(
    `SELECT skill_version,
            count(*) as run_count,
            max(started_at)::text as last_run,
            avg((token_usage->>'turns')::int) as avg_turns
     FROM nexaas_memory.skill_runs
     WHERE workspace = $1 AND skill_id = $2 AND skill_version IS NOT NULL
     GROUP BY skill_version
     ORDER BY max(started_at) DESC
     LIMIT $3`,
    [workspace, skillId, limit],
  );

  return history.map(h => ({
    version: h.skill_version,
    runCount: parseInt(h.run_count, 10),
    lastRun: h.last_run,
    avgTurns: parseFloat(h.avg_turns) || 0,
  }));
}
