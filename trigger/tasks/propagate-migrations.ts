/**
 * Propagate database migrations to all client VPS instances.
 *
 * Reads SQL files from database/migrations/, applies pending ones
 * to the orchestrator first, then to each workspace via SSH + psql.
 *
 * Tracks applied migrations in the schema_migrations table.
 * All migrations are idempotent (IF NOT EXISTS), so re-running is safe.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { runShell } from "../lib/shell.js";
import { loadManifest } from "../../orchestrator/bootstrap/manifest-loader.js";
import { query, queryAll } from "../../orchestrator/db.js";
import { readdirSync } from "fs";
import { join } from "path";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT || process.cwd();
const MIGRATIONS_DIR = join(NEXAAS_ROOT, "database", "migrations");

interface MigrationFile {
  filename: string;
  path: string;
}

interface InstanceResult {
  applied: string[];
  skipped: string[];
  error?: string;
}

function getWorkspaceIds(): string[] {
  const dir = join(NEXAAS_ROOT, "workspaces");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".workspace.json") && !f.startsWith("_"))
    .map((f) => f.replace(".workspace.json", ""));
}

function getMigrationFiles(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ filename: f, path: join(MIGRATIONS_DIR, f) }));
}

async function getLocalApplied(): Promise<Set<string>> {
  try {
    const rows = await queryAll<{ filename: string }>(
      `SELECT filename FROM schema_migrations`
    );
    return new Set(rows.map((r) => r.filename));
  } catch {
    // Table doesn't exist yet — will be created by 000_schema_migrations.sql
    return new Set();
  }
}

async function getRemoteApplied(
  sshOpts: string,
  target: string,
): Promise<Set<string>> {
  const result = await runShell({
    command: `ssh ${sshOpts} ${target} "psql \\$DATABASE_URL -t -A -c \\"SELECT filename FROM schema_migrations\\" 2>/dev/null"`,
    timeoutMs: 15_000,
  });

  if (!result.success || !result.stdout.trim()) {
    return new Set();
  }

  return new Set(
    result.stdout.trim().split("\n").filter((l) => l.trim()),
  );
}

export const propagateMigrations = task({
  id: "propagate-migrations",
  queue: { name: "orchestrator", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload?: { workspaceId?: string }) => {
    const migrations = getMigrationFiles();
    logger.info(`Found ${migrations.length} migration files`);

    // ── 1. Apply to orchestrator DB first ─────────────────────────────
    const localApplied = await getLocalApplied();
    const localPending = migrations.filter((m) => !localApplied.has(m.filename));

    if (localPending.length > 0) {
      logger.info(`Applying ${localPending.length} pending migrations locally`);
      for (const m of localPending) {
        const result = await runShell({
          command: `psql $DATABASE_URL < "${m.path}"`,
          timeoutMs: 30_000,
        });
        if (result.success) {
          await query(
            `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
            [m.filename],
          );
          logger.info(`Local: applied ${m.filename}`);
        } else {
          logger.error(`Local: failed ${m.filename}`, { stderr: result.stderr.slice(0, 500) });
          // Don't break — local migrations are idempotent, try the rest
        }
      }
    } else {
      logger.info("Orchestrator DB is current");
    }

    // ── 2. Propagate to instances ─────────────────────────────────────
    const workspaceIds = payload?.workspaceId
      ? [payload.workspaceId]
      : getWorkspaceIds();

    const results: Record<string, InstanceResult> = {};

    for (const wsId of workspaceIds) {
      try {
        const manifest = await loadManifest(wsId);
        if (!manifest.ssh) {
          results[wsId] = { applied: [], skipped: [], error: "no SSH config" };
          continue;
        }

        const { host, user, port } = manifest.ssh;
        const target = `${user}@${host}`;
        const sshOpts = `-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -p ${port}`;

        const applied = await getRemoteApplied(sshOpts, target);
        const pending = migrations.filter((m) => !applied.has(m.filename));

        if (pending.length === 0) {
          results[wsId] = { applied: [], skipped: migrations.map((m) => m.filename) };
          logger.info(`${wsId}: all ${migrations.length} migrations applied`);
          continue;
        }

        logger.info(`${wsId}: ${pending.length} pending migrations`);
        const appliedNow: string[] = [];

        for (const m of pending) {
          // Pipe SQL file via SSH stdin
          const result = await runShell({
            command: `cat "${m.path}" | ssh ${sshOpts} ${target} "psql \\$DATABASE_URL"`,
            timeoutMs: 30_000,
          });

          if (result.success) {
            // Record in remote schema_migrations
            await runShell({
              command: `ssh ${sshOpts} ${target} "psql \\$DATABASE_URL -c \\"INSERT INTO schema_migrations (filename) VALUES ('${m.filename}') ON CONFLICT DO NOTHING\\""`,
              timeoutMs: 10_000,
            });
            appliedNow.push(m.filename);
            logger.info(`${wsId}: applied ${m.filename}`);
          } else {
            logger.error(`${wsId}: failed ${m.filename}`, { stderr: result.stderr.slice(0, 500) });
            // Break for this instance — later migrations may depend on this one
            results[wsId] = {
              applied: appliedNow,
              skipped: [],
              error: `Failed on ${m.filename}: ${result.stderr.slice(0, 200)}`,
            };
            break;
          }
        }

        if (!results[wsId]) {
          results[wsId] = { applied: appliedNow, skipped: [] };
        }
      } catch (e) {
        results[wsId] = { applied: [], skipped: [], error: String(e).slice(0, 300) };
        logger.error(`${wsId}: migration propagation failed — ${e}`);
      }
    }

    // Summary
    const totalApplied = Object.values(results).reduce((n, r) => n + r.applied.length, 0);
    const totalErrors = Object.values(results).filter((r) => r.error).length;
    logger.info(`Migration propagation complete: ${totalApplied} applied across ${workspaceIds.length} instances, ${totalErrors} errors`);

    return results;
  },
});
