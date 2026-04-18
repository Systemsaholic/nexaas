/**
 * nexaas propagate — push library skill updates to workspaces.
 *
 * Commands:
 *   nexaas propagate check              Check for pending proposals across workspaces
 *   nexaas propagate push <skill-id>    Push a library skill update to all subscribed workspaces
 *   nexaas propagate accept <proposal>  Accept a pending proposal for this workspace
 *   nexaas propagate reject <proposal>  Reject a pending proposal
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import pg from "pg";

interface ProposalRow {
  id: number;
  workspace: string;
  skill_id: string;
  library_version: string;
  local_version: string;
  status: string;
  created_at: string;
}

export async function run(args: string[]) {
  const subcommand = args[0];
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT ?? "";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  await ensureProposalTable(pool);

  switch (subcommand) {
    case "check": {
      const proposals = await pool.query(`
        SELECT id, workspace, skill_id, library_version, local_version, status, created_at::text
        FROM nexaas_memory.skill_proposals
        WHERE status = 'pending'
        ORDER BY created_at DESC
      `);

      console.log("\n  Pending Skill Proposals\n");

      if (proposals.rows.length === 0) {
        console.log("  (none — all workspaces up to date)\n");
        break;
      }

      for (const p of proposals.rows as ProposalRow[]) {
        console.log(`  #${p.id} ${p.skill_id}`);
        console.log(`    Workspace: ${p.workspace}`);
        console.log(`    Library: v${p.library_version} → Local: v${p.local_version}`);
        console.log(`    Created: ${p.created_at}`);
        console.log(`    Accept: nexaas propagate accept ${p.id}`);
        console.log("");
      }
      break;
    }

    case "push": {
      const skillId = args[1];
      if (!skillId) {
        console.error("Usage: nexaas propagate push <skill-id>");
        process.exit(1);
      }

      const libResult = await pool.query(
        `SELECT content FROM nexaas_memory.events
         WHERE wing = 'library' AND hall = 'skills' AND room = $1
           AND event_type = 'skill-registration'
         ORDER BY created_at DESC LIMIT 1`,
        [skillId],
      );

      if (libResult.rows.length === 0) {
        console.error(`  Skill '${skillId}' not found in library`);
        process.exit(1);
      }

      const libData = JSON.parse(libResult.rows[0].content);

      const workspaces = await pool.query(
        `SELECT DISTINCT workspace FROM nexaas_memory.workspace_config`,
      );

      let proposed = 0;
      for (const ws of workspaces.rows) {
        const wsId = ws.workspace as string;

        const localSkillDir = await getWorkspaceSkillDir(pool, wsId, skillId);
        if (!localSkillDir) continue;

        const localManifestPath = join(localSkillDir, "skill.yaml");
        if (!existsSync(localManifestPath)) continue;

        const { load: yamlLoad } = await import("js-yaml");
        const localManifest = yamlLoad(readFileSync(localManifestPath, "utf-8")) as { version?: string };
        const localVersion = localManifest.version ?? "0.0.0";

        if (localVersion === libData.version) continue;

        const existing = await pool.query(
          `SELECT id FROM nexaas_memory.skill_proposals
           WHERE workspace = $1 AND skill_id = $2 AND library_version = $3 AND status = 'pending'`,
          [wsId, skillId, libData.version],
        );

        if (existing.rows.length > 0) continue;

        await pool.query(
          `INSERT INTO nexaas_memory.skill_proposals
            (workspace, skill_id, library_version, local_version, library_content, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [wsId, skillId, libData.version, localVersion, JSON.stringify(libData)],
        );

        proposed++;
        console.log(`  → Proposed: ${skillId} v${libData.version} for ${wsId} (currently v${localVersion})`);
      }

      if (proposed === 0) {
        console.log(`\n  No workspaces need updating for ${skillId}\n`);
      } else {
        console.log(`\n  ✓ Created ${proposed} proposal(s)\n`);
      }

      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'library_propagate', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          workspace,
          JSON.stringify({ skill_id: skillId, version: libData.version, proposals_created: proposed }),
          "0".repeat(64),
          `propagate-${skillId}-${Date.now()}`,
        ],
      );
      break;
    }

    case "accept": {
      const proposalId = parseInt(args[1], 10);
      if (!proposalId) {
        console.error("Usage: nexaas propagate accept <proposal-id>");
        process.exit(1);
      }

      const proposal = await pool.query(
        `SELECT * FROM nexaas_memory.skill_proposals WHERE id = $1 AND status = 'pending'`,
        [proposalId],
      );

      if (proposal.rows.length === 0) {
        console.error(`  Proposal #${proposalId} not found or not pending`);
        process.exit(1);
      }

      const p = proposal.rows[0];
      const libData = JSON.parse(p.library_content);
      const targetDir = await getWorkspaceSkillDir(pool, p.workspace, p.skill_id);

      if (!targetDir) {
        console.error(`  Cannot resolve skill directory for ${p.workspace}/${p.skill_id}`);
        process.exit(1);
      }

      mkdirSync(targetDir, { recursive: true });

      for (const [filename, fileContent] of Object.entries(libData.files as Record<string, string>)) {
        writeFileSync(join(targetDir, filename), fileContent);
      }

      await pool.query(
        `UPDATE nexaas_memory.skill_proposals SET status = 'accepted', resolved_at = now() WHERE id = $1`,
        [proposalId],
      );

      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'proposal_accepted', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          p.workspace,
          JSON.stringify({ proposal_id: proposalId, skill_id: p.skill_id, version: libData.version }),
          "0".repeat(64),
          `accept-${proposalId}-${Date.now()}`,
        ],
      );

      console.log(`\n  ✓ Accepted proposal #${proposalId}`);
      console.log(`    Skill: ${p.skill_id} updated to v${libData.version}`);
      console.log(`    Location: ${targetDir}\n`);
      break;
    }

    case "reject": {
      const proposalId = parseInt(args[1], 10);
      if (!proposalId) {
        console.error("Usage: nexaas propagate reject <proposal-id>");
        process.exit(1);
      }

      await pool.query(
        `UPDATE nexaas_memory.skill_proposals SET status = 'rejected', resolved_at = now() WHERE id = $1 AND status = 'pending'`,
        [proposalId],
      );

      console.log(`\n  ✓ Rejected proposal #${proposalId}\n`);
      break;
    }

    default:
      console.log(`
  nexaas propagate — push library skill updates to workspaces

  Commands:
    check                    List pending proposals across all workspaces
    push <skill-id>          Push a library update to subscribed workspaces
    accept <proposal-id>     Accept a pending proposal (installs the update)
    reject <proposal-id>     Reject a pending proposal

  Proposals are non-destructive: they create entries that ops reviews.
  Minor versions may auto-apply; major versions always require review.
`);
  }

  await pool.end();
}

async function ensureProposalTable(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexaas_memory.skill_proposals (
      id SERIAL PRIMARY KEY,
      workspace TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      library_version TEXT NOT NULL,
      local_version TEXT NOT NULL,
      library_content JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getWorkspaceSkillDir(pool: pg.Pool, wsId: string, skillId: string): Promise<string | null> {
  const config = await pool.query(
    `SELECT value FROM nexaas_memory.workspace_config WHERE workspace = $1 AND key = 'workspace_root'`,
    [wsId],
  );

  const root = config.rows[0]?.value;
  if (!root) return null;

  return join(root, "nexaas-skills", ...skillId.split("/"));
}
