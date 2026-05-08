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

      // Step 4b: Compile TS → JS for production (#37). The systemd unit
      // runs compiled JS via `node --conditions=production dist/worker.js`.
      // Build is fast (<10s on a warm cache) and skipped only when no
      // source files changed.
      const sourceChanged = changedFiles.split("\n").some((f) => /^(packages|integrations|mcp\/servers)\/[^/]+\/(src|tsconfig)/.test(f));
      if (sourceChanged || !existsSync(join(nexaasRoot, "packages/runtime/dist/worker.js"))) {
        console.log("  Building production JS...");
        exec(`cd ${nexaasRoot} && npm run build`, { timeout: 300_000 });
        if (!existsSync(join(nexaasRoot, "packages/runtime/dist/worker.js"))) {
          console.error("  Build failed — packages/runtime/dist/worker.js missing.");
          process.exit(1);
        }
        console.log("  Build complete");
      }

      // Step 4c: Auto-migrate the systemd unit if it's still on the old
      // tsx-based ExecStart. New installs (#37) write the compiled-JS
      // form directly; existing installs flip on first upgrade.
      maybeMigrateSystemdUnit(nexaasRoot);
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

/**
 * Flip an existing nexaas-worker.service from the legacy tsx ExecStart
 * to the compiled-JS form (#37). One-shot: detects the old `node tsx
 * .../src/worker.ts` invocation and rewrites it to
 * `node --conditions=production .../dist/worker.js`. No-op once
 * migrated. The unit ships compiled-by-default for new installs.
 */
function maybeMigrateSystemdUnit(nexaasRoot: string): void {
  const unitPath = "/etc/systemd/system/nexaas-worker.service";
  if (!existsSync(unitPath)) return;

  let unit: string;
  try {
    unit = readFileSync(unitPath, "utf-8");
  } catch {
    return; // No permission to read — leave alone.
  }

  // Already migrated.
  if (unit.includes("--conditions=production") && unit.includes("dist/worker.js")) return;

  // Match the legacy form: `ExecStart=<node> <tsx> .../packages/runtime/src/worker.ts`
  const legacy = /^ExecStart=(\S+)\s+\S+tsx\S*\s+\S+\/packages\/runtime\/src\/worker\.ts.*$/m;
  const m = unit.match(legacy);
  if (!m) return; // Some other custom form — don't touch.

  const nodeBin = m[1]!;
  const newExecStart = `ExecStart=${nodeBin} --conditions=production ${nexaasRoot}/packages/runtime/dist/worker.js`;
  const migrated = unit.replace(legacy, newExecStart);

  console.log("\n  Migrating systemd unit to compiled-JS ExecStart (#37)...");
  try {
    exec(`sudo tee ${unitPath} > /dev/null <<'NEXAAS_UNIT_EOF'\n${migrated}\nNEXAAS_UNIT_EOF`);
    exec("sudo systemctl daemon-reload");
    console.log("  Systemd unit migrated");
  } catch (e) {
    console.error(`  Systemd unit migration failed (will retry next upgrade): ${(e as Error).message}`);
  }
}

async function getPendingMigrations(pool: pg.Pool, nexaasRoot: string): Promise<string[]> {
  const migrationsDir = join(nexaasRoot, "database/migrations");
  if (!existsSync(migrationsDir)) return [];

  const allFiles = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  let applied: Set<string>;
  try {
    // Ensure tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nexaas_memory.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // If tracking is empty but tables exist, seed with all existing migrations
    const trackCount = await pool.query(`SELECT count(*) FROM nexaas_memory.schema_migrations`);
    if (parseInt(trackCount.rows[0].count, 10) === 0) {
      const tableCount = await pool.query(
        `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'nexaas_memory'`,
      );
      if (parseInt(tableCount.rows[0].count, 10) > 5) {
        // Tables exist — seed tracking with all migrations
        for (const f of allFiles) {
          await pool.query(
            `INSERT INTO nexaas_memory.schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
            [f],
          );
        }
      }
    }

    const result = await pool.query(`SELECT filename FROM nexaas_memory.schema_migrations`);
    applied = new Set(result.rows.map(r => r.filename));
  } catch {
    applied = new Set();
  }

  return allFiles.filter(f => !applied.has(f));
}
