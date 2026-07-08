#!/usr/bin/env node
/**
 * CI helper: apply all framework migrations to $DATABASE_URL and exit
 * non-zero on any failure. The DB-gated harnesses in scripts/ (see
 * tests/harnesses.test.ts) expect a fully-migrated scratch database; CI
 * runs this once before `vitest run`.
 *
 * NOTE applyPendingMigrations reports failure via `result.failed` — it does
 * not throw (callers decide how fatal failures surface). Ignoring the return
 * value silently truncates the schema at the first failing migration.
 */
import pg from "pg";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyPendingMigrations } from "../packages/cli/src/migrations.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const result = await applyPendingMigrations(pool, root);
await pool.end();

if (result.failed) {
  console.error(`\n✗ migration ${result.failed.filename} failed: ${result.failed.error}`);
  process.exit(1);
}
console.log(`\n✓ migrations complete (${result.applied.length} applied, ${result.legacyResolved.length} legacy-resolved)`);
