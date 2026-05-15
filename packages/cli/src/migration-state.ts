/**
 * nexaas migration-state — print canonical migration tracker state.
 *
 * Direct-adopter workspaces can end up with two `schema_migrations` tables —
 * one in `public` (residual from a pre-palace migration runner), one in
 * `nexaas_memory` (the framework's real tracker). Operators or tooling that
 * default to `\dt` or query the wrong one get a misleading answer. See #184.
 *
 * This command always reads from `nexaas_memory.schema_migrations`, compares
 * to the migration files on disk, and warns about residual `public` state.
 *
 * Usage:
 *   nexaas migration-state           Human-readable summary
 *   nexaas migration-state --json    Machine-readable output
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import { createPool, sql, sqlOne } from "@nexaas/palace";

interface AppliedRow {
  filename: string;
  applied_at: string;
}

interface ResidualRow {
  filename: string;
}

interface State {
  canonical_schema: "nexaas_memory";
  canonical_table: "nexaas_memory.schema_migrations";
  applied_count: number;
  applied: AppliedRow[];
  pending: string[];
  migrations_dir: string;
  residual_public: {
    table_exists: boolean;
    row_count: number;
    rows: ResidualRow[];
  };
}

function findMigrationsDir(): string | null {
  const fromEnv = process.env.NEXAAS_ROOT;
  const candidates = [
    fromEnv ? join(fromEnv, "database", "migrations") : null,
    "/opt/nexaas/database/migrations",
    join(process.cwd(), "database", "migrations"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function gatherState(): Promise<State> {
  const migrationsDir = findMigrationsDir();
  if (!migrationsDir) {
    throw new Error(
      "Could not locate database/migrations directory. " +
        "Set NEXAAS_ROOT or run from within the framework checkout.",
    );
  }

  const onDisk = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = await sql<AppliedRow>(
    `SELECT filename, applied_at::text AS applied_at
       FROM nexaas_memory.schema_migrations
      ORDER BY applied_at, filename`,
  );

  const appliedSet = new Set(applied.map((r) => r.filename));
  const pending = onDisk.filter((f) => !appliedSet.has(f));

  // Detect residual public.schema_migrations — common foot-gun on
  // pre-palace deploys.
  const publicTableCheck = await sqlOne<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
     ) AS exists`,
  );
  const publicTableExists = publicTableCheck?.exists ?? false;

  let residualRows: ResidualRow[] = [];
  if (publicTableExists) {
    try {
      residualRows = await sql<ResidualRow>(
        `SELECT filename FROM public.schema_migrations ORDER BY filename`,
      );
    } catch {
      // Column name differs in some legacy installs; best-effort.
      residualRows = [];
    }
  }

  return {
    canonical_schema: "nexaas_memory",
    canonical_table: "nexaas_memory.schema_migrations",
    applied_count: applied.length,
    applied,
    pending,
    migrations_dir: migrationsDir,
    residual_public: {
      table_exists: publicTableExists,
      row_count: residualRows.length,
      rows: residualRows,
    },
  };
}

function printHuman(state: State): void {
  console.log(`\n  Nexaas Migration State`);
  console.log(`  ────────────────────────────────────────────────────`);
  console.log(`  Canonical tracker:  ${state.canonical_table}`);
  console.log(`  Migrations dir:     ${state.migrations_dir}`);
  console.log(`  Applied:            ${state.applied_count}`);
  console.log(`  Pending:            ${state.pending.length}`);

  if (state.applied_count > 0) {
    const latest = state.applied[state.applied.length - 1]!;
    console.log(`  Latest applied:     ${latest.filename} (${latest.applied_at})`);
  }

  if (state.pending.length > 0) {
    console.log(`\n  Pending migrations (newest last):`);
    for (const f of state.pending) {
      console.log(`    • ${f}`);
    }
    console.log(`\n  Run 'nexaas upgrade --migrate' to apply.`);
  } else {
    console.log(`\n  ✓ All migration files on disk are applied.`);
  }

  if (state.residual_public.table_exists) {
    console.log(`\n  ⚠ Residual public.schema_migrations table detected (${state.residual_public.row_count} rows).`);
    console.log(`    This is leftover from a pre-palace migration runner — the framework`);
    console.log(`    no longer reads it. It can be confused with the real tracker by`);
    console.log(`    operators or tooling that default to the public schema.`);
    if (state.residual_public.row_count > 0) {
      console.log(`    Rows:`);
      for (const r of state.residual_public.rows) {
        console.log(`      • ${r.filename}`);
      }
    }
    console.log(`    See #184. Safe to drop after verifying no local tooling reads it.`);
  }
  console.log();
}

export async function run(args: string[] = []) {
  const wantJson = args.includes("--json");

  createPool();

  let state: State;
  try {
    state = await gatherState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (wantJson) {
      console.log(JSON.stringify({ error: msg }));
    } else {
      console.error(`\n  ✗ ${msg}\n`);
    }
    process.exit(1);
  }

  if (wantJson) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    printHuman(state);
  }

  process.exit(state.pending.length === 0 ? 0 : 2);
}
