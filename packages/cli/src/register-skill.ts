/**
 * nexaas register-skill — register a skill manifest with the BullMQ scheduler.
 *
 * Usage:
 *   nexaas register-skill <path-to-skill.yaml>
 *
 * Reads the manifest, registers cron triggers with BullMQ, and confirms.
 *
 * The core registration logic lives in `registerOneSkill()` and is reused
 * by `register-skills.ts` for bulk operation. Everything that's expensive
 * to set up — the Redis/BullMQ connection, the workspace timezone lookup —
 * is passed in by the caller so a bulk run does it once for N manifests.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { load as yamlLoad } from "js-yaml";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  timezone?: string;
  triggers?: Array<{
    type: string;
    schedule?: string;
    timezone?: string;
  }>;
  execution?: {
    type: string;
    command?: string;
    timeout?: number;
    working_directory?: string;
  };
}

export interface RegisterContext {
  queue: Queue;
  workspace: string;
  workspaceTz: string;
}

export interface RegisterResult {
  skillId: string;
  version: string;
  registered: number;
  cleaned: number;
  status: "registered" | "no-triggers" | "error";
  error?: string;
}

const USAGE = `\
Usage: nexaas register-skill <path-to-skill.yaml>

Registers a skill manifest with the BullMQ scheduler. Reads the manifest,
upserts every cron trigger as a repeatable BullMQ job, and prints a
confirmation. Existing repeatables for the same skill ID are cleaned up
before the new one is upserted.

Bulk equivalent:
  nexaas register-skills <dir>           Register every skill.yaml under <dir>

Required env: NEXAAS_WORKSPACE
Optional env: REDIS_URL (default redis://localhost:6379), DATABASE_URL
              (for workspace-scoped timezone lookup)
`;

function printUsage(): void {
  process.stdout.write(USAGE);
}

/**
 * Resolve the workspace's preferred timezone from `nexaas_memory.workspace_config`.
 * Used as the default for cron triggers that don't pin their own. Hoisted out
 * of the per-skill loop so the bulk command pays the psql cost exactly once.
 */
export function resolveWorkspaceTimezone(workspace: string): string {
  try {
    const dbUrl = process.env.DATABASE_URL ?? "";
    if (!dbUrl) return "UTC";
    const result = execSync(
      `psql "${dbUrl}" -c "SELECT timezone FROM nexaas_memory.workspace_config WHERE workspace = '${workspace}'" -t -A 2>/dev/null`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
    return result || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Register a single skill manifest. Pass a shared `RegisterContext` so a
 * bulk caller can reuse the Redis connection and workspace timezone lookup.
 *
 * Returns a structured result; never throws for normal manifest issues
 * (missing file, bad YAML, no triggers) — those land in `result.error`
 * so a bulk run can summarize the outcome instead of aborting on the
 * first bad manifest.
 */
export async function registerOneSkill(
  manifestPath: string,
  ctx: RegisterContext,
): Promise<RegisterResult> {
  if (!existsSync(manifestPath)) {
    return {
      skillId: manifestPath,
      version: "?",
      registered: 0,
      cleaned: 0,
      status: "error",
      error: `manifest not found at '${manifestPath}' — pass an absolute path or run from $NEXAAS_WORKSPACE_ROOT`,
    };
  }

  let manifest: SkillManifest;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    manifest = yamlLoad(content) as SkillManifest;
    if (!manifest?.id || !manifest?.version) {
      return {
        skillId: manifestPath,
        version: "?",
        registered: 0,
        cleaned: 0,
        status: "error",
        error: "manifest missing required `id` or `version`",
      };
    }
  } catch (err) {
    return {
      skillId: manifestPath,
      version: "?",
      registered: 0,
      cleaned: 0,
      status: "error",
      error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let registered = 0;
  let cleaned = 0;

  if (!manifest.triggers || manifest.triggers.length === 0) {
    return {
      skillId: manifest.id,
      version: manifest.version,
      registered: 0,
      cleaned: 0,
      status: "no-triggers",
    };
  }

  for (const trigger of manifest.triggers) {
    if (trigger.type !== "cron" || !trigger.schedule) continue;

    const jobName = `cron-${manifest.id.replace(/\//g, "-")}`;
    const tz =
      trigger.timezone ??
      manifest.timezone ??
      ctx.workspaceTz ??
      process.env.NEXAAS_TIMEZONE ??
      "UTC";

    // Remove any legacy repeatable entries for this skill (#22).
    try {
      const existing = await ctx.queue.getRepeatableJobs();
      const stale = existing.filter((j) => j.name === jobName);
      for (const j of stale) {
        await ctx.queue.removeRepeatableByKey(j.key);
      }
      cleaned += stale.length;
    } catch { /* non-fatal */ }

    await ctx.queue.upsertJobScheduler(
      jobName,
      { pattern: trigger.schedule, tz },
      {
        name: "skill-step",
        data: {
          workspace: ctx.workspace,
          skillId: manifest.id,
          skillVersion: manifest.version,
          stepId: manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec",
          triggerType: "cron",
          manifestPath,
        },
      },
    );

    registered++;
  }

  return {
    skillId: manifest.id,
    version: manifest.version,
    registered,
    cleaned,
    status: registered > 0 ? "registered" : "no-triggers",
  };
}

export async function run(args: string[]) {
  // Help flag — pre-#87 this crashed because args[0] was passed straight
  // to readFileSync as a manifest path.
  if (args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  const manifestPath = args[0];
  if (!manifestPath) {
    console.error(USAGE);
    process.exit(1);
  }

  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  // Resolve relative paths against $NEXAAS_WORKSPACE_ROOT when set, so
  // `nexaas register-skill nexaas-skills/foo/skill.yaml` works regardless
  // of the caller's cwd. Adopters were hitting this from automation scripts.
  const resolved =
    manifestPath.startsWith("/") || !process.env.NEXAAS_WORKSPACE_ROOT
      ? manifestPath
      : resolve(process.env.NEXAAS_WORKSPACE_ROOT, manifestPath);

  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  const queue = new Queue(`nexaas-skills-${workspace}`, { connection });
  const workspaceTz = resolveWorkspaceTimezone(workspace);

  try {
    const result = await registerOneSkill(resolved, { queue, workspace, workspaceTz });

    if (result.status === "error") {
      console.error(`  ✗ ${result.error}`);
      process.exit(1);
    }

    console.log(`\n  Registering skill: ${result.skillId} v${result.version}`);
    if (result.cleaned > 0) {
      console.log(`  Cleaned ${result.cleaned} legacy repeatable(s)`);
    }
    if (result.status === "no-triggers") {
      console.log("  ⚠ No cron triggers found in this manifest");
    } else {
      console.log(`  ✓ ${result.registered} cron trigger(s) registered`);
    }
    console.log(`\n  Skill registered. Next fire will appear in Bull Board at /queues\n`);
  } finally {
    await connection.quit();
  }
}
