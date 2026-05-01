/**
 * nexaas upgrade — pull latest framework and apply pending migrations.
 *
 * Steps:
 *   1. Check current version
 *   2. Git pull latest
 *   3. npm install (if package.json changed)
 *   4. Apply pending database migrations
 *   5. Restart worker
 *   6. Verify health
 *
 * Usage:
 *   nexaas upgrade              Pull + migrate + restart
 *   nexaas upgrade --check      Check for updates without applying
 *   nexaas upgrade --migrate    Only apply pending migrations
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

function exec(cmd: string, opts?: { silent?: boolean; timeout?: number }): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: opts?.timeout ?? 60_000 }).trim();
  } catch (e) {
    if (!opts?.silent) throw e;
    return "";
  }
}

export async function run(args: string[]) {
  const checkOnly = args.includes("--check");
  const migrateOnly = args.includes("--migrate");
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  console.log("\n  Nexaas Upgrade\n");

  // Step 1: Check current version
  const currentCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });
  const currentBranch = exec(`git -C ${nexaasRoot} rev-parse --abbrev-ref HEAD`, { silent: true });
  console.log(`  Current: ${currentCommit} (${currentBranch})`);

  if (!migrateOnly) {
    // Step 2: Check for updates
    exec(`git -C ${nexaasRoot} fetch origin ${currentBranch} --quiet`, { silent: true });
    const behind = exec(`git -C ${nexaasRoot} rev-list HEAD..origin/${currentBranch} --count`, { silent: true });
    const behindCount = parseInt(behind, 10) || 0;

    if (behindCount === 0) {
      console.log("  Status: up to date");
    } else {
      console.log(`  Status: ${behindCount} commit(s) behind origin/${currentBranch}`);

      const newCommits = exec(
        `git -C ${nexaasRoot} log --oneline HEAD..origin/${currentBranch} | head -10`,
        { silent: true },
      );
      if (newCommits) {
        console.log("\n  New commits:");
        for (const line of newCommits.split("\n")) {
          console.log(`    ${line}`);
        }
      }
    }

    if (checkOnly) {
      // Check pending migrations
      const pending = await getPendingMigrations(pool, nexaasRoot);
      if (pending.length > 0) {
        console.log(`\n  Pending migrations: ${pending.length}`);
        for (const m of pending) console.log(`    ${m}`);
      }
      console.log("");
      await pool.end();
      return;
    }

    if (behindCount > 0) {
      // Step 3: Pull
      console.log("\n  Pulling latest...");
      const pullResult = exec(`git -C ${nexaasRoot} pull origin ${currentBranch}`, { timeout: 120_000 });
      console.log(`  ${pullResult.split("\n").pop()}`);

      // Step 4: npm install if package.json changed
      const changedFiles = exec(
        `git -C ${nexaasRoot} diff --name-only ${currentCommit}..HEAD`,
        { silent: true },
      );
      if (changedFiles.includes("package.json") || changedFiles.includes("package-lock.json")) {
        console.log("  Running npm install...");
        exec(`cd ${nexaasRoot} && npm install --production 2>/dev/null`, { timeout: 300_000 });
        console.log("  Dependencies updated");
      }
    }
  }

  // Step 5: Apply pending migrations.
  //
  // Each migration runs inside its own transaction with the schema_migrations
  // marker INSERT — atomic apply + record. If the SQL fails partway, the
  // marker rolls back too. This prevents the failure mode in #72 where the
  // marker outlasted a failed apply and the dispatcher silently broke for
  // days waiting on a table that was recorded as created but didn't exist.
  const pending = await getPendingMigrations(pool, nexaasRoot);
  if (pending.length > 0) {
    console.log(`\n  Applying ${pending.length} migration(s)...`);
    for (const migration of pending) {
      const sqlPath = join(nexaasRoot, "database/migrations", migration);
      const sqlContent = readFileSync(sqlPath, "utf-8");
      const client = await pool.connect();
      let migrationFailed = false;
      try {
        await client.query("BEGIN");
        await client.query(sqlContent);
        await client.query(
          `INSERT INTO nexaas_memory.schema_migrations (filename, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`,
          [migration],
        );
        await client.query("COMMIT");
        console.log(`    ✓ ${migration}`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => { /* best effort */ });
        console.error(`    ✗ ${migration}: ${(e as Error).message}`);
        console.error("  Migration failed — stopping. Fix the issue and run 'nexaas upgrade --migrate'");
        migrationFailed = true;
      } finally {
        client.release();
      }
      // Exit AFTER release so the connection always returns to the pool —
      // process.exit doesn't run finally on the *outer* scope, but we already
      // released in the inner finally. Belt and suspenders: see PR #77 review.
      if (migrationFailed) process.exit(1);
    }
  } else {
    console.log("  Migrations: up to date");
  }

  if (!migrateOnly) {
    // Step 6: Restart worker
    console.log("\n  Restarting worker...");
    try {
      exec("sudo systemctl restart nexaas-worker", { timeout: 30_000 });
    } catch {
      exec("systemctl restart nexaas-worker", { timeout: 30_000, silent: true });
    }

    // Step 7: Verify health (wait a bit)
    console.log("  Waiting for health check...");
    let healthy = false;
    for (let i = 0; i < 6; i++) {
      execSync("sleep 5", { stdio: "pipe" });
      const health = exec("curl -sf --max-time 3 http://localhost:9090/health", { silent: true });
      if (health) {
        try {
          const parsed = JSON.parse(health);
          if (parsed.status === "healthy") {
            healthy = true;
            break;
          }
        } catch { /* try again */ }
      }
    }

    const newCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });

    if (healthy) {
      console.log(`\n  ✓ Upgrade complete: ${currentCommit} → ${newCommit}`);
    } else {
      console.log(`\n  ⚠ Upgraded to ${newCommit} but health check did not pass`);
      console.log("    Check: nexaas status");
    }
  }

  // The restarted worker fires a startup heartbeat to the fleet dashboard
  // within ~5s of coming up (see packages/runtime/src/fleet/heartbeat.ts).
  // Poll `framework_heartbeat.last_push_at` briefly so the operator can see
  // confirmation before the command exits.
  if (!migrateOnly) {
    try {
      let confirmed = false;
      for (let i = 0; i < 6; i++) {
        execSync("sleep 2", { stdio: "pipe" });
        const row = await pool.query(
          `SELECT version, commit_sha, last_push_at, last_push_status
           FROM nexaas_memory.framework_heartbeat WHERE workspace = $1`,
          [workspace],
        );
        const hb = row.rows[0];
        if (hb?.last_push_at && (Date.now() - new Date(hb.last_push_at).getTime()) < 30_000) {
          console.log(`  ✓ Fleet heartbeat: ${hb.version} (${hb.commit_sha}) — ${hb.last_push_status}`);
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        console.log("  ⚠ Fleet heartbeat not seen yet — check NEXAAS_FLEET_ENDPOINT / NEXAAS_FLEET_TOKEN in .env if the dashboard doesn't pick up the new version.");
      }
    } catch (err) {
      // framework_heartbeat table missing → pre-015 install. No action.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("framework_heartbeat")) {
        console.log(`  ⚠ Heartbeat confirmation skipped: ${msg.slice(0, 120)}`);
      }
    }
  }

  console.log("");
  await pool.end();
}

async function getPendingMigrations(pool: pg.Pool, nexaasRoot: string): Promise<string[]> {
  const migrationsDir = join(nexaasRoot, "database/migrations");
  if (!existsSync(migrationsDir)) return [];

  const allFiles = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  let applied: Set<string>;
  try {
    // Ensure tracking table exists.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nexaas_memory.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // No seed-all heuristic. The previous "if schema_migrations is empty and
    // nexaas_memory has >5 tables, mark every migration as applied" path was
    // the root cause of #72 — it stamped migrations that init.ts never ran
    // (e.g. 016/017 added after the workspace was set up) as applied without
    // executing their SQL. All migrations use CREATE TABLE/INDEX IF NOT
    // EXISTS, so re-running them on a workspace whose tables were created by
    // init.ts is safe (idempotent) and self-heals the schema_migrations row
    // set on the first post-fix upgrade.

    const result = await pool.query(`SELECT filename FROM nexaas_memory.schema_migrations`);
    applied = new Set(result.rows.map(r => r.filename));
  } catch {
    applied = new Set();
  }

  return allFiles.filter(f => !applied.has(f));
}
