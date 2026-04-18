/**
 * nexaas backup — per-workspace database backups.
 *
 * Commands:
 *   nexaas backup                     Run a backup now
 *   nexaas backup list                List recent backups
 *   nexaas backup restore <id>        Restore from a backup
 *   nexaas backup test <id>           Test-restore a backup (non-destructive)
 *   nexaas backup schedule            Show/set backup schedule
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import pg from "pg";

function exec(cmd: string, opts?: { timeout?: number }): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: opts?.timeout ?? 120_000 }).trim();
  } catch {
    return "";
  }
}

export async function run(args: string[]) {
  const subcommand = args[0] ?? "now";
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const backupDir = process.env.NEXAAS_BACKUP_DIR ?? "/var/backups/nexaas";

  switch (subcommand) {
    case "now":
    case "run": {
      mkdirSync(backupDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `${workspace}-${timestamp}.sql.gz`;
      const filepath = join(backupDir, filename);

      console.log(`\n  Starting backup: ${workspace}`);
      console.log(`  Target: ${filepath}`);

      // Record start
      const startResult = await pool.query(
        `INSERT INTO nexaas_memory.backup_history
          (workspace, backup_type, started_at, status)
         VALUES ($1, 'full', now(), 'running')
         RETURNING id`,
        [workspace],
      );
      const backupId = startResult.rows[0].id;

      try {
        // Parse DB URL for pg_dump
        const url = new URL(dbUrl);
        const host = url.hostname;
        const port = url.port || "5432";
        const dbName = url.pathname.slice(1);
        const user = url.username;

        const dumpCmd = `PGPASSWORD=${url.password} pg_dump -h ${host} -p ${port} -U ${user} -d ${dbName} --no-owner --no-privileges -n nexaas_memory 2>/dev/null | gzip > ${filepath}`;
        execSync(dumpCmd, { stdio: "pipe", timeout: 300_000 });

        if (!existsSync(filepath) || statSync(filepath).size < 100) {
          throw new Error("Backup file is empty or missing");
        }

        const sizeBytes = statSync(filepath).size;
        const hash = createHash("sha256").update(readFileSync(filepath)).digest("hex");

        await pool.query(
          `UPDATE nexaas_memory.backup_history
           SET status = 'completed', completed_at = now(), size_bytes = $1, sha256 = $2,
               object_key = $3
           WHERE id = $4`,
          [sizeBytes, hash, filepath, backupId],
        );

        const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2);
        console.log(`  Size: ${sizeMb} MB`);
        console.log(`  SHA256: ${hash.slice(0, 16)}...`);
        console.log(`\n  ✓ Backup complete: #${backupId}\n`);

        // Retention: keep last 30 backups, remove older
        await cleanOldBackups(backupDir, workspace, 30);
      } catch (e) {
        await pool.query(
          `UPDATE nexaas_memory.backup_history
           SET status = 'failed', completed_at = now(), error_message = $1
           WHERE id = $2`,
          [String((e as Error).message).slice(0, 500), backupId],
        );
        console.error(`  ✗ Backup failed: ${(e as Error).message}\n`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const limit = parseInt(args[1] ?? "10", 10);
      const backups = await pool.query(
        `SELECT id, backup_type, status, started_at::text, completed_at::text,
                size_bytes, sha256, object_key, restore_tested, restore_passed
         FROM nexaas_memory.backup_history
         WHERE workspace = $1
         ORDER BY started_at DESC LIMIT $2`,
        [workspace, limit],
      );

      console.log("\n  Recent Backups\n");

      if (backups.rows.length === 0) {
        console.log("  (no backups yet — run: nexaas backup)\n");
        break;
      }

      for (const b of backups.rows) {
        const sizeMb = b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(1)}MB` : "-";
        const tested = b.restore_tested ? (b.restore_passed ? "tested-ok" : "tested-FAIL") : "untested";
        const icon = b.status === "completed" ? "✓" : b.status === "failed" ? "✗" : "…";
        console.log(`  ${icon} #${b.id} ${b.started_at} [${b.status}] ${sizeMb} ${tested}`);
        if (b.object_key) console.log(`    ${b.object_key}`);
      }
      console.log("");
      break;
    }

    case "test": {
      const backupId = parseInt(args[1], 10);
      if (!backupId) {
        console.error("Usage: nexaas backup test <backup-id>");
        process.exit(1);
      }

      const backup = await pool.query(
        `SELECT * FROM nexaas_memory.backup_history WHERE id = $1 AND workspace = $2`,
        [backupId, workspace],
      );

      if (backup.rows.length === 0) {
        console.error(`  Backup #${backupId} not found`);
        process.exit(1);
      }

      const b = backup.rows[0];
      if (!b.object_key || !existsSync(b.object_key)) {
        console.error(`  Backup file not found: ${b.object_key}`);
        process.exit(1);
      }

      console.log(`\n  Testing restore of backup #${backupId}...`);

      const testDb = `nexaas_restore_test_${Date.now()}`;
      const url = new URL(dbUrl);

      try {
        // Create test database
        exec(`PGPASSWORD=${url.password} createdb -h ${url.hostname} -p ${url.port || 5432} -U ${url.username} ${testDb}`);

        // Create schema
        exec(`PGPASSWORD=${url.password} psql -h ${url.hostname} -p ${url.port || 5432} -U ${url.username} -d ${testDb} -c "CREATE SCHEMA IF NOT EXISTS nexaas_memory" 2>/dev/null`);

        // Restore
        const restoreCmd = `gunzip -c ${b.object_key} | PGPASSWORD=${url.password} psql -h ${url.hostname} -p ${url.port || 5432} -U ${url.username} -d ${testDb} 2>/dev/null`;
        exec(restoreCmd, { timeout: 300_000 });

        // Verify key tables exist
        const tables = exec(`PGPASSWORD=${url.password} psql -h ${url.hostname} -p ${url.port || 5432} -U ${url.username} -d ${testDb} -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'nexaas_memory'" 2>/dev/null`);
        const tableCount = parseInt(tables, 10);

        const passed = tableCount >= 10;

        await pool.query(
          `UPDATE nexaas_memory.backup_history
           SET restore_tested = true, restore_test_at = now(), restore_passed = $1
           WHERE id = $2`,
          [passed, backupId],
        );

        if (passed) {
          console.log(`  ✓ Restore test PASSED (${tableCount} tables restored)`);
        } else {
          console.log(`  ✗ Restore test FAILED (only ${tableCount} tables restored)`);
        }
      } finally {
        // Drop test database
        exec(`PGPASSWORD=${url.password} dropdb -h ${url.hostname} -p ${url.port || 5432} -U ${url.username} --if-exists ${testDb} 2>/dev/null`);
      }

      console.log("");
      break;
    }

    case "schedule": {
      console.log("\n  Backup Schedule\n");
      console.log("  To set up automated daily backups, add a cron job:");
      console.log("");
      console.log(`  # Daily at 3 AM (run as the nexaas user):`);
      console.log(`  0 3 * * * source /opt/nexaas/.env && /usr/local/bin/nexaas backup run >> /var/log/nexaas-backup.log 2>&1`);
      console.log("");
      console.log(`  Current backup directory: ${backupDir}`);

      const lastBackup = await pool.query(
        `SELECT started_at::text, status FROM nexaas_memory.backup_history
         WHERE workspace = $1 ORDER BY started_at DESC LIMIT 1`,
        [workspace],
      );

      if (lastBackup.rows.length > 0) {
        console.log(`  Last backup: ${lastBackup.rows[0].started_at} (${lastBackup.rows[0].status})`);
      } else {
        console.log("  Last backup: never");
      }
      console.log("");
      break;
    }

    default:
      console.log(`
  nexaas backup — per-workspace database backups

  Commands:
    (default) / run     Run a backup now
    list [n]            List recent backups (default: 10)
    test <id>           Test-restore a backup (non-destructive)
    schedule            Show backup schedule instructions
`);
  }

  await pool.end();
}

function cleanOldBackups(dir: string, workspace: string, keep: number) {
  try {
    const files = readdirSync(dir)
      .filter((f: string) => f.startsWith(`${workspace}-`) && f.endsWith(".sql.gz"))
      .sort()
      .reverse();

    for (const file of files.slice(keep)) {
      try { unlinkSync(join(dir, file)); } catch { /* skip */ }
    }
  } catch { /* skip */ }
}
