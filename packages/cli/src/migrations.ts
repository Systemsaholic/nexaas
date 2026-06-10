/**
 * Shared tracked migration runner (#218) — used by `nexaas init` and
 * `nexaas upgrade` so both record into the canonical tracker
 * (`nexaas_memory.schema_migrations`).
 *
 * History: init applied migrations via a raw `psql … 2>/dev/null` loop and
 * never created or populated the tracker — a fresh install reported every
 * migration as pending until its first upgrade self-healed the rows (#218).
 * The runner here is the one the upgrade path proved in production, hoisted
 * with two fresh-database accommodations:
 *
 *   1. The tracker lives in the `nexaas_memory` schema, which historically
 *      only existed after migration 012 ran. `ensureTracker()` creates the
 *      schema + table up front (CREATE IF NOT EXISTS — a no-op everywhere
 *      012 already ran).
 *
 *   2. Pre-palace legacy migrations (filename < 012) ALTER tables that only
 *      ever existed on pre-framework deploys — on a bare database they fail
 *      by design, and the framework reads none of what they touch. Halting
 *      a fresh install on them is wrong; leaving them pending forever fails
 *      `migration-state` and the conformance gate. Policy: a failure in a
 *      legacy-range migration is recorded as resolved with a loud warning.
 *      Failures from 012 onward remain fatal (returned to the caller).
 *
 * Apply + record happen in one transaction per file — if the SQL fails
 * partway, the tracker row rolls back too (the #72 failure mode).
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

/** Migrations lexicographically below this are pre-palace legacy. */
const LEGACY_BOUNDARY = "012";

export interface ApplyResult {
  applied: string[];
  /** Legacy migrations that failed and were recorded as resolved. */
  legacyResolved: string[];
  /** Set when a post-legacy migration failed — fatal for the caller. */
  failed?: { filename: string; error: string };
}

/**
 * Create the canonical tracker (and its schema) if absent. Safe to call on
 * any database state.
 */
export async function ensureTracker(pool: pg.Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS nexaas_memory`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexaas_memory.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function getPendingMigrations(pool: pg.Pool, nexaasRoot: string): Promise<string[]> {
  const migrationsDir = join(nexaasRoot, "database/migrations");
  if (!existsSync(migrationsDir)) return [];

  const allFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let applied: Set<string>;
  try {
    await ensureTracker(pool);

    // No seed-all heuristic. The previous "if schema_migrations is empty and
    // nexaas_memory has >5 tables, mark every migration as applied" path was
    // the root cause of #72 — it stamped migrations that init.ts never ran
    // (e.g. 016/017 added after the workspace was set up) as applied without
    // executing their SQL. Post-012 migrations use CREATE TABLE/INDEX IF NOT
    // EXISTS, so re-running them on a workspace whose tables were created by
    // a pre-tracker init is safe (idempotent) and self-heals the
    // schema_migrations row set on the first tracked run.

    const result = await pool.query(`SELECT filename FROM nexaas_memory.schema_migrations`);
    applied = new Set(result.rows.map((r) => r.filename as string));
  } catch {
    applied = new Set();
  }

  return allFiles.filter((f) => !applied.has(f));
}

/**
 * Apply every pending migration in filename order. Returns rather than
 * exits — callers decide how a fatal failure surfaces (upgrade halts with
 * remediation guidance; init fails the install).
 */
export async function applyPendingMigrations(
  pool: pg.Pool,
  nexaasRoot: string,
  log: (line: string) => void = console.log,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], legacyResolved: [] };
  const pending = await getPendingMigrations(pool, nexaasRoot);
  if (pending.length === 0) return result;

  log(`  Applying ${pending.length} migration(s)...`);
  for (const migration of pending) {
    const sqlPath = join(nexaasRoot, "database/migrations", migration);
    const sqlContent = readFileSync(sqlPath, "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sqlContent);
      await client.query(
        `INSERT INTO nexaas_memory.schema_migrations (filename, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`,
        [migration],
      );
      await client.query("COMMIT");
      result.applied.push(migration);
      log(`    ✓ ${migration}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* best effort */ });
      const error = (e as Error).message;

      if (migration < LEGACY_BOUNDARY) {
        // Pre-palace legacy — inapplicable on this database. Record as
        // resolved so it never shows pending; warn so the operator can
        // audit the decision.
        try {
          await client.query(
            `INSERT INTO nexaas_memory.schema_migrations (filename, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`,
            [migration],
          );
          result.legacyResolved.push(migration);
          log(`    ⚠ ${migration}: inapplicable pre-palace legacy migration — recorded as resolved (${error.slice(0, 100)})`);
        } catch (recordErr) {
          client.release();
          result.failed = { filename: migration, error: `legacy-resolve record failed: ${(recordErr as Error).message}` };
          return result;
        }
      } else {
        client.release();
        result.failed = { filename: migration, error };
        return result;
      }
    }
    client.release();
  }
  return result;
}
