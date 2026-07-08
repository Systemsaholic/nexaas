/**
 * Bridge: runs every `scripts/test-*.mjs` regression harness under vitest
 * so CI executes them on each PR (#257). The harnesses predate the test
 * runner — each is a standalone assert-and-exit script (exit 0 = pass) that
 * stays runnable directly (`node --import tsx scripts/test-x.mjs`) for
 * issue-repro workflows. New harnesses dropped into scripts/ are picked up
 * automatically; prefer writing new coverage as plain vitest tests in
 * tests/ instead.
 *
 * Classification is by file content, not a hardcoded list:
 *   - references DATABASE_URL / pg pools  → needs a migrated scratch
 *     Postgres; skipped unless DATABASE_URL is set (CI provides one; never
 *     point this at a production database — harnesses INSERT/UPDATE freely)
 *   - references REDIS_URL / bullmq       → additionally needs REDIS_URL
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

const DB_RE = /DATABASE_URL|new pg\.|createPool|getPool/;
const REDIS_RE = /REDIS_URL|ioredis|bullmq/;

const harnesses = readdirSync(SCRIPTS)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort()
  .map((file) => {
    const src = readFileSync(join(SCRIPTS, file), "utf-8");
    return { file, db: DB_RE.test(src), redis: REDIS_RE.test(src) };
  });

const hasDb = Boolean(process.env.DATABASE_URL);
const hasRedis = Boolean(process.env.REDIS_URL);

function runHarness(file: string): void {
  try {
    execFileSync("node", ["--import", "tsx", join(SCRIPTS, file)], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 110_000,
      env: process.env,
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    throw new Error(
      `${file} exited ${e.status}\n--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}`,
    );
  }
}

describe("scripts/ regression harnesses", () => {
  for (const h of harnesses) {
    const skip = (h.db && !hasDb) || (h.redis && !hasRedis);
    it.skipIf(skip)(
      `${h.file}${h.db ? " [db]" : ""}${h.redis ? " [redis]" : ""}`,
      () => runHarness(h.file),
    );
  }
});
