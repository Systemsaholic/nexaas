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

  // Step 5: Apply pending migrations
  const pending = await getPendingMigrations(pool, nexaasRoot);
  if (pending.length > 0) {
    console.log(`\n  Applying ${pending.length} migration(s)...`);
    for (const migration of pending) {
      try {
        const sqlPath = join(nexaasRoot, "database/migrations", migration);
        const sqlContent = readFileSync(sqlPath, "utf-8");
        await pool.query(sqlContent);
        await pool.query(
          `INSERT INTO nexaas_memory.schema_migrations (filename, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`,
          [migration],
        );
        console.log(`    ✓ ${migration}`);
      } catch (e) {
        console.error(`    ✗ ${migration}: ${(e as Error).message}`);
        console.error("  Migration failed — stopping. Fix the issue and run 'nexaas upgrade --migrate'");
        process.exit(1);
      }
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

  // Record in framework_versions
  try {
    const newCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });
    await pool.query(
      `INSERT INTO nexaas_memory.framework_versions (workspace, version, commit_hash, applied_at, applied_by)
       VALUES ($1, $2, $3, now(), 'nexaas-upgrade')
       ON CONFLICT DO NOTHING`,
      [workspace, newCommit, exec(`git -C ${nexaasRoot} rev-parse HEAD`, { silent: true })],
    );
  } catch { /* non-fatal */ }

  console.log("");
  await pool.end();
}

async function getPendingMigrations(pool: pg.Pool, nexaasRoot: string): Promise<string[]> {
  const migrationsDir = join(nexaasRoot, "database/migrations");
  if (!existsSync(migrationsDir)) return [];

  const allFiles = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  // Check which are already applied
  let applied: Set<string>;
  try {
    const result = await pool.query(
      `SELECT filename FROM nexaas_memory.schema_migrations`,
    );
    applied = new Set(result.rows.map(r => r.filename));
  } catch {
    // Table might not exist yet
    applied = new Set();
  }

  return allFiles.filter(f => !applied.has(f));
}
