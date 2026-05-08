/**
 * nexaas register-skills — bulk register every skill manifest under a directory.
 *
 * Usage:
 *   nexaas register-skills [<dir>]                  default: $NEXAAS_WORKSPACE_ROOT/nexaas-skills
 *   nexaas register-skills <dir> --dry-run          show what would change
 *   nexaas register-skills <dir> --only <substr>    only manifests whose path
 *                                                   contains <substr>
 *
 * Why: re-registering N manifests via N invocations of `nexaas register-skill`
 * spawns N tsx + Node + ioredis + psql lookups (Phoenix observed ~7 min
 * for 138 skills). This command opens one Redis connection, does the
 * workspace-timezone lookup once, walks the dir, and registers each
 * manifest in-process. Wall time drops to seconds.
 *
 * Returns a summary line: `registered / updated / no-triggers / errors`.
 */

import { readdirSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  printOverlapWarnings,
  registerOneSkill,
  resolveWorkspaceTimezone,
  type RegisterResult,
} from "./register-skill.js";

const USAGE = `\
Usage: nexaas register-skills [<dir>] [--dry-run] [--only <substr>]

Bulk-register every skill.yaml under <dir>. Defaults to
$NEXAAS_WORKSPACE_ROOT/nexaas-skills if omitted.

Options:
  --dry-run         List manifests that would be registered, exit 0.
  --only <substr>   Only register manifests whose path contains <substr>
                    (e.g. --only marketing/ to limit by category).

Required env: NEXAAS_WORKSPACE
Optional env: NEXAAS_WORKSPACE_ROOT (default location for the skills tree),
              REDIS_URL, DATABASE_URL.
`;

function printUsage(): void {
  process.stdout.write(USAGE);
}

/** Walk a directory tree, collect every `skill.yaml` we find. */
function findManifests(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch { continue; }
    for (const entry of entries) {
      const path = join(cur, entry);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(path);
      } else if (basename(path) === "skill.yaml") {
        out.push(path);
      }
    }
  }
  // Stable order so successive runs print the same sequence.
  return out.sort();
}

interface Options {
  dir: string;
  dryRun: boolean;
  only: string | null;
}

function parseArgs(args: string[]): Options | "help" {
  if (args.includes("--help") || args.includes("-h")) return "help";

  let dir: string | null = null;
  let dryRun = false;
  let only: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--only") { only = args[++i] ?? null; }
    else if (!a.startsWith("--")) { dir = a; }
  }

  if (!dir) {
    if (!process.env.NEXAAS_WORKSPACE_ROOT) {
      console.error("No directory given and NEXAAS_WORKSPACE_ROOT is unset.");
      console.error(USAGE);
      process.exit(1);
    }
    dir = join(process.env.NEXAAS_WORKSPACE_ROOT, "nexaas-skills");
  }

  return { dir: resolve(dir), dryRun, only };
}

export async function run(args: string[]) {
  const parsed = parseArgs(args);
  if (parsed === "help") {
    printUsage();
    return;
  }
  const { dir, dryRun, only } = parsed;

  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  let manifests = findManifests(dir);
  if (only) {
    manifests = manifests.filter((p) => p.includes(only));
  }
  if (manifests.length === 0) {
    console.log(`  No skill.yaml files found under ${dir}${only ? ` matching --only '${only}'` : ""}`);
    return;
  }

  console.log(`\n  Found ${manifests.length} manifest(s) under ${dir}${only ? ` (filtered by '${only}')` : ""}`);

  if (dryRun) {
    for (const p of manifests) console.log(`  [dry-run] would register ${p}`);
    console.log(`\n  Dry-run complete: ${manifests.length} manifest(s)\n`);
    return;
  }

  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const queue = new Queue(`nexaas-skills-${workspace}`, { connection });
  const workspaceTz = resolveWorkspaceTimezone(workspace);

  let registered = 0;
  let noTriggers = 0;
  let errors = 0;
  let totalCronTriggers = 0;
  let totalCleaned = 0;
  const errorDetails: Array<{ path: string; error: string }> = [];

  try {
    const start = Date.now();
    for (const path of manifests) {
      const result: RegisterResult = await registerOneSkill(path, { queue, workspace, workspaceTz });
      totalCronTriggers += result.registered;
      totalCleaned += result.cleaned;

      if (result.status === "error") {
        errors++;
        errorDetails.push({ path, error: result.error ?? "unknown error" });
        console.log(`  ✗ ${path}: ${result.error}`);
      } else if (result.status === "no-triggers") {
        noTriggers++;
        // Quiet by default — common for sub-skills with no cron triggers.
      } else {
        registered++;
        console.log(`  ✓ ${result.skillId} v${result.version} (${result.registered} cron trigger${result.registered === 1 ? "" : "s"})`);
        if (result.warnings && result.warnings.length > 0) {
          printOverlapWarnings(result.warnings, result.skillId);
        }
      }
    }
    const elapsedMs = Date.now() - start;

    console.log(
      `\n  Summary: ${registered} registered, ${noTriggers} no-triggers, ${errors} error(s) ` +
      `— ${totalCronTriggers} cron trigger(s) upserted, ${totalCleaned} legacy repeatable(s) cleaned ` +
      `in ${(elapsedMs / 1000).toFixed(1)}s\n`,
    );

    if (errors > 0) {
      console.log("  Errors:");
      for (const e of errorDetails) console.log(`    ${e.path}: ${e.error}`);
      process.exit(1);
    }
  } finally {
    await connection.quit();
  }
}
