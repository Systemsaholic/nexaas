/**
 * nexaas library — manage the skill library.
 *
 * Commands:
 *   nexaas library list                    List all skills in the library
 *   nexaas library contribute <path>       Contribute a workspace skill to the library
 *   nexaas library install <skill-id>      Install a library skill to this workspace
 *   nexaas library diff <skill-id>         Show diff between workspace and library versions
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { load as yamlLoad } from "js-yaml";
import pg from "pg";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  execution?: { type: string };
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

  switch (subcommand) {
    case "list": {
      console.log("\n  Nexaas Skill Library\n");

      // List skills from the palace library room
      const skills = await pool.query(`
        SELECT content, created_at::text
        FROM nexaas_memory.events
        WHERE workspace = $1
          AND wing = 'library'
          AND hall = 'skills'
          AND event_type = 'skill-registration'
        ORDER BY created_at DESC
      `, [workspace]);

      if (skills.rows.length === 0) {
        console.log("  (empty — contribute skills with 'nexaas library contribute <path>')");
      } else {
        for (const row of skills.rows) {
          try {
            const data = JSON.parse(row.content);
            const type = data.execution_type === "ai-skill" ? "🤖" : "⚙️";
            console.log(`  ${type} ${data.id} v${data.version} — ${data.description ?? ""}`);
          } catch { /* skip unparseable */ }
        }
      }

      // Also list workspace skills not yet in library
      const skillsDir = join(workspaceRoot, "nexaas-skills");
      if (existsSync(skillsDir)) {
        const localSkills = findSkillManifests(skillsDir);
        const libraryIds = skills.rows.map((r: { content: string }) => {
          try { return JSON.parse(r.content).id; } catch { return ""; }
        });

        const uncontributed = localSkills.filter(s => !libraryIds.includes(s.id));
        if (uncontributed.length > 0) {
          console.log(`\n  Workspace skills not yet in library (${uncontributed.length}):`);
          for (const s of uncontributed) {
            console.log(`    • ${s.id} v${s.version} — contribute with: nexaas library contribute ${s.path}`);
          }
        }
      }

      console.log("");
      break;
    }

    case "contribute": {
      const manifestPath = args[1];
      if (!manifestPath) {
        console.error("Usage: nexaas library contribute <path-to-skill.yaml>");
        process.exit(1);
      }

      if (!existsSync(manifestPath)) {
        console.error(`File not found: ${manifestPath}`);
        process.exit(1);
      }

      const content = readFileSync(manifestPath, "utf-8");
      const manifest = yamlLoad(content) as SkillManifest;
      const skillDir = dirname(manifestPath);

      // Read all skill files
      const files: Record<string, string> = {};
      for (const file of ["skill.yaml", "prompt.md", "task.ts"]) {
        const filePath = join(skillDir, file);
        if (existsSync(filePath)) {
          files[file] = readFileSync(filePath, "utf-8");
        }
      }

      const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");

      // Check if already contributed at this version
      const existing = await pool.query(
        `SELECT id FROM nexaas_memory.events
         WHERE workspace = $1 AND wing = 'library' AND hall = 'skills' AND room = $2
           AND content_hash = $3`,
        [workspace, manifest.id, hash],
      );

      if (existing.rows.length > 0) {
        console.log(`\n  ⚠ ${manifest.id} v${manifest.version} already in library (unchanged)\n`);
        break;
      }

      // Register in the library
      await pool.query(
        `INSERT INTO nexaas_memory.events
          (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id, metadata)
         VALUES ($1, 'library', 'skills', $2, $3, $4, 'skill-registration', 'library', $2, $5)`,
        [
          workspace,
          manifest.id,
          JSON.stringify({
            id: manifest.id,
            version: manifest.version,
            description: manifest.description,
            execution_type: manifest.execution?.type,
            files,
            contributed_at: new Date().toISOString(),
            source_path: manifestPath,
          }),
          hash,
          JSON.stringify({ version: manifest.version, source: "workspace-contribute" }),
        ],
      );

      // WAL entry
      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'library_contribute', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          workspace,
          JSON.stringify({ skill_id: manifest.id, version: manifest.version }),
          "0".repeat(64),
          `contribute-${manifest.id}-${Date.now()}`,
        ],
      );

      console.log(`\n  ✓ Contributed: ${manifest.id} v${manifest.version} to the library`);
      console.log(`    Files: ${Object.keys(files).join(", ")}`);
      console.log(`    Hash: ${hash.slice(0, 12)}...\n`);
      break;
    }

    case "install": {
      const skillId = args[1];
      if (!skillId) {
        console.error("Usage: nexaas library install <skill-id>");
        process.exit(1);
      }

      // Get the latest version from library
      const result = await pool.query(
        `SELECT content FROM nexaas_memory.events
         WHERE workspace = $1 AND wing = 'library' AND hall = 'skills' AND room = $2
           AND event_type = 'skill-registration'
         ORDER BY created_at DESC LIMIT 1`,
        [workspace, skillId],
      );

      if (result.rows.length === 0) {
        console.error(`  Skill '${skillId}' not found in library`);
        process.exit(1);
      }

      const data = JSON.parse(result.rows[0].content);
      const targetDir = join(workspaceRoot, "nexaas-skills", ...skillId.split("/"));
      mkdirSync(targetDir, { recursive: true });

      for (const [filename, fileContent] of Object.entries(data.files as Record<string, string>)) {
        writeFileSync(join(targetDir, filename), fileContent);
      }

      console.log(`\n  ✓ Installed: ${skillId} v${data.version}`);
      console.log(`    Location: ${targetDir}`);
      console.log(`    Files: ${Object.keys(data.files).join(", ")}`);
      console.log(`    Register with: nexaas register-skill ${join(targetDir, "skill.yaml")}\n`);
      break;
    }

    case "diff": {
      const skillId = args[1];
      if (!skillId) {
        console.error("Usage: nexaas library diff <skill-id>");
        process.exit(1);
      }

      // Get library version
      const libResult = await pool.query(
        `SELECT content FROM nexaas_memory.events
         WHERE workspace = $1 AND wing = 'library' AND hall = 'skills' AND room = $2
           AND event_type = 'skill-registration'
         ORDER BY created_at DESC LIMIT 1`,
        [workspace, skillId],
      );

      if (libResult.rows.length === 0) {
        console.error(`  Skill '${skillId}' not found in library`);
        process.exit(1);
      }

      const libData = JSON.parse(libResult.rows[0].content);
      const localDir = join(workspaceRoot, "nexaas-skills", ...skillId.split("/"));

      console.log(`\n  Diff: ${skillId}\n`);
      console.log(`  Library: v${libData.version} (contributed ${libData.contributed_at})`);

      if (!existsSync(localDir)) {
        console.log(`  Local: not installed`);
        console.log(`  → Install with: nexaas library install ${skillId}\n`);
        break;
      }

      for (const filename of ["skill.yaml", "prompt.md"]) {
        const libContent = (libData.files as Record<string, string>)[filename] ?? "";
        const localPath = join(localDir, filename);
        const localContent = existsSync(localPath) ? readFileSync(localPath, "utf-8") : "";

        if (libContent === localContent) {
          console.log(`  ${filename}: identical`);
        } else if (!libContent) {
          console.log(`  ${filename}: local only (not in library)`);
        } else if (!localContent) {
          console.log(`  ${filename}: library only (not installed locally)`);
        } else {
          console.log(`  ${filename}: DIFFERS`);
          console.log(`    Library: ${libContent.length} chars`);
          console.log(`    Local:   ${localContent.length} chars`);
        }
      }
      console.log("");
      break;
    }

    case "promote": {
      const skillId = args[1];
      if (!skillId) {
        console.error("Usage: nexaas library promote <skill-id>");
        process.exit(1);
      }

      const libResult = await pool.query(
        `SELECT content, content_hash FROM nexaas_memory.events
         WHERE wing = 'library' AND hall = 'skills' AND room = $1
           AND event_type = 'skill-registration'
         ORDER BY created_at DESC LIMIT 1`,
        [skillId],
      );

      if (libResult.rows.length === 0) {
        console.error(`  Skill '${skillId}' not found in library`);
        process.exit(1);
      }

      const data = JSON.parse(libResult.rows[0].content);

      // Check if already promoted at this version
      const existing = await pool.query(
        `SELECT id FROM nexaas_memory.events
         WHERE wing = 'library' AND hall = 'canonical' AND room = $1
           AND content_hash = $2`,
        [skillId, libResult.rows[0].content_hash],
      );

      if (existing.rows.length > 0) {
        console.log(`\n  ⚠ ${skillId} v${data.version} is already canonical\n`);
        break;
      }

      // Promote: copy to canonical hall
      await pool.query(
        `INSERT INTO nexaas_memory.events
          (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id, metadata)
         VALUES ($1, 'library', 'canonical', $2, $3, $4, 'skill-promotion', 'library', $2, $5)`,
        [
          workspace,
          skillId,
          libResult.rows[0].content,
          libResult.rows[0].content_hash,
          JSON.stringify({ version: data.version, promoted_at: new Date().toISOString(), promoted_by: "ops" }),
        ],
      );

      // WAL entry
      await pool.query(
        `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash)
         SELECT $1, 'library_promote', 'nexaas-cli',
           $2::jsonb,
           COALESCE((SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1), $3),
           encode(digest($4, 'sha256'), 'hex')`,
        [
          workspace,
          JSON.stringify({ skill_id: skillId, version: data.version }),
          "0".repeat(64),
          `promote-${skillId}-${Date.now()}`,
        ],
      );

      console.log(`\n  ✓ Promoted: ${skillId} v${data.version} → canonical`);
      console.log(`    This version is now the recommended baseline for all workspaces.\n`);
      break;
    }

    case "feedback": {
      const skillId = args[1];

      console.log("\n  Skill Improvement Signals\n");

      let query = `
        SELECT content, created_at::text, room
        FROM nexaas_memory.events
        WHERE wing = 'library' AND hall = 'feedback'
          AND event_type = 'skill-improvement'
        ORDER BY created_at DESC LIMIT 20
      `;
      const params: string[] = [];

      if (skillId) {
        query = `
          SELECT content, created_at::text, room
          FROM nexaas_memory.events
          WHERE wing = 'library' AND hall = 'feedback' AND room = $1
            AND event_type = 'skill-improvement'
          ORDER BY created_at DESC LIMIT 20
        `;
        params.push(skillId);
      }

      const signals = await pool.query(query, params);

      if (signals.rows.length === 0) {
        console.log("  (no improvement signals captured yet)\n");
        break;
      }

      for (const row of signals.rows) {
        try {
          const data = JSON.parse(row.content);
          console.log(`  [${row.created_at}] ${row.room}`);
          console.log(`    ${(data.reflection ?? data.content ?? "").slice(0, 120)}`);
          console.log("");
        } catch { /* skip */ }
      }
      break;
    }

    default:
      console.log(`
  nexaas library — manage the skill library

  Commands:
    list                    List all skills in the library
    contribute <path>       Contribute a workspace skill to the library
    install <skill-id>      Install a library skill to this workspace
    diff <skill-id>         Compare workspace vs library versions
    promote <skill-id>      Promote a skill to canonical status
    feedback [skill-id]     View skill improvement signals

  The library is stored in the palace (library/skills/* rooms).
  Any Nexaas workspace on this VPS can share skills through the library.
`);
  }

  await pool.end();
}

function findSkillManifests(dir: string): Array<SkillManifest & { path: string }> {
  const results: Array<SkillManifest & { path: string }> = [];

  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(join(d, entry.name));
      } else if (entry.name === "skill.yaml") {
        try {
          const content = readFileSync(join(d, entry.name), "utf-8");
          const manifest = yamlLoad(content) as SkillManifest;
          if (manifest.id) {
            results.push({ ...manifest, path: join(d, entry.name) });
          }
        } catch { /* skip */ }
      }
    }
  }

  walk(dir);
  return results;
}
