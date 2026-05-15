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
import { resolve, dirname, join } from "path";
import { execSync } from "child_process";
import { load as yamlLoad } from "js-yaml";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import parser from "cron-parser";
import {
  loadPersonaProfile,
  upsertPaThreads,
  detectPaReplyUser,
  isEphemeralPath,
  type UpsertSummary,
} from "@nexaas/runtime";

export interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  timezone?: string;
  /**
   * Mutex groups (#95 / #96). Skills sharing a group serialize at the
   * worker. The CLI also uses the list at registration time to flag
   * cron-overlap with already-registered skills (#99).
   */
  concurrency_groups?: string[];
  triggers?: Array<{
    type: string;
    schedule?: string;
    timezone?: string;
    channel_role?: string;            // for type=inbound-message; e.g. "pa_reply_<user>"
  }>;
  execution?: {
    type: string;
    command?: string;
    timeout?: number;
    working_directory?: string;
  };
}

/**
 * Normalize a YAML-parsed manifest into the framework's `SkillManifest`
 * shape (#139). Accepts both:
 *
 *   1. The framework's `skill.yaml` format — `id:`, `version:`, `triggers:[]`,
 *      `execution.timeout` (ms). Pass-through.
 *
 *   2. The richer `contract.yaml` format used by some adopters (Nexmatic
 *      skill packages, for instance) — `skill:` + `category:` instead of
 *      `id:`, top-level `schedule:` instead of `triggers:[]`,
 *      `execution.timeout_seconds:` instead of `execution.timeout` (ms).
 *      Plus product-level fields (`produces:`, `outputs:`, `tag_defaults:`,
 *      `client_must_configure:`, etc.) the framework already ignores as
 *      unknown fields.
 *
 * Detection heuristic: missing `id` AND present `skill` → contract shape.
 * Otherwise treated as native skill.yaml.
 *
 * Pure helper: no I/O, no side effects. Tested in
 * `scripts/test-manifest-normalize-139.mjs`.
 */
export function normalizeManifest(raw: Record<string, unknown> | null): SkillManifest {
  if (!raw || typeof raw !== "object") {
    return {} as SkillManifest;
  }
  const r = raw as Record<string, unknown>;
  const isContract = typeof r.id !== "string" && typeof r.skill === "string";
  if (!isContract) {
    return r as unknown as SkillManifest;
  }

  // ── contract.yaml → skill.yaml translation ────────────────────────
  const skill = String(r.skill);
  // If `skill:` already contains a slash, skip the category prefix.
  // Otherwise, prepend `category:` when present.
  const id = skill.includes("/")
    ? skill
    : typeof r.category === "string" && r.category.length > 0
      ? `${r.category}/${skill}`
      : skill;

  // Triggers: prefer explicit `triggers:[]` when present; otherwise lift
  // top-level `schedule:` into a cron trigger.
  let triggers = Array.isArray(r.triggers) ? (r.triggers as SkillManifest["triggers"]) : undefined;
  if (!triggers && typeof r.schedule === "string" && r.schedule.length > 0) {
    triggers = [{ type: "cron", schedule: r.schedule }];
  }

  // Execution: prefer `execution.timeout` (ms) when present; otherwise
  // convert `execution.timeout_seconds` (s) → ms.
  const execIn = (r.execution as Record<string, unknown> | undefined) ?? undefined;
  let execution: SkillManifest["execution"] | undefined;
  if (execIn) {
    const timeoutMs = typeof execIn.timeout === "number"
      ? (execIn.timeout as number)
      : typeof execIn.timeout_seconds === "number"
        ? Math.floor((execIn.timeout_seconds as number) * 1000)
        : undefined;
    execution = {
      type: typeof execIn.type === "string" ? (execIn.type as string) : "shell",
      ...(typeof execIn.command === "string" ? { command: execIn.command as string } : {}),
      ...(typeof timeoutMs === "number" ? { timeout: timeoutMs } : {}),
      ...(typeof execIn.working_directory === "string" ? { working_directory: execIn.working_directory as string } : {}),
    };
  }

  return {
    ...r,
    id,
    version: typeof r.version === "string" ? r.version : "0",
    ...(triggers ? { triggers } : {}),
    ...(execution ? { execution } : {}),
  } as unknown as SkillManifest;
}

export interface RegisterContext {
  queue: Queue;
  workspace: string;
  workspaceTz: string;
  /**
   * Allow registering a manifest stored under an ephemeral filesystem path
   * (`/tmp`, `/run`, `/var/tmp`, `/dev/shm`, `$XDG_RUNTIME_DIR`). Default
   * `false` — those paths get garbage-collected by systemd-tmpfiles, the
   * kernel on boot, or OOM-prompted /tmp sweeps, leaving the BullMQ
   * scheduler ticking on a phantom skill (#172).
   *
   * The CLI exposes this as `--allow-ephemeral`. Library/programmatic
   * callers can pass `true` when they explicitly know the storage layer
   * (e.g. integration tests writing to a tmpdir they control for the
   * duration of the run).
   */
  allowEphemeral?: boolean;
}

/**
 * One overlap detected between the skill being registered and an
 * already-registered one — both share at least one concurrency_group
 * and their next-1h cron fires intersect (#99).
 */
export interface CronOverlapWarning {
  group: string;
  newPattern: string;
  conflicts: Array<{ skillId: string; pattern: string }>;
}

export interface RegisterResult {
  skillId: string;
  version: string;
  registered: number;
  cleaned: number;
  status: "registered" | "no-triggers" | "error";
  error?: string;
  warnings?: CronOverlapWarning[];
  /** PA-as-Router (#122). Set when this skill is a PA conversation-turn skill. */
  paProfile?: {
    userHall: string;
    profilePath: string;
    summary: UpsertSummary;
  };
}

const USAGE = `\
Usage: nexaas register-skill <path-to-skill.yaml> [--allow-ephemeral]

Registers a skill manifest with the BullMQ scheduler. Reads the manifest,
upserts every cron trigger as a repeatable BullMQ job, and prints a
confirmation. Existing repeatables for the same skill ID are cleaned up
before the new one is upserted.

Flags:
  --allow-ephemeral   Permit registering a manifest stored under /tmp,
                      /run, /var/tmp, /dev/shm, or \$XDG_RUNTIME_DIR.
                      Refused by default — those paths get cleaned and
                      leave the scheduler firing on a phantom skill.

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
 * Compute the set of next-N cron fires for a pattern, truncated to the
 * minute (HH:MM ISO prefix). Used by the cron-overlap detector — two
 * patterns overlap when their next-fire sets intersect.
 *
 * 12 fires is the bar: covers ~1h of `*\/5` cadence, ~3h of `*\/15`,
 * a full day of hourly. Cheap to compute, good enough to catch the
 * cases the issue's mock output shows. cron-parser is a transitive
 * dep via BullMQ.
 */
function nextFireSet(pattern: string, tz: string, count = 12): Set<string> {
  try {
    const it = parser.parseExpression(pattern, { tz, currentDate: new Date() });
    const out = new Set<string>();
    for (let i = 0; i < count; i++) {
      out.add(it.next().toDate().toISOString().slice(0, 16));
    }
    return out;
  } catch {
    return new Set();
  }
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Inspect existing job schedulers for cron overlap with the new skill (#99).
 *
 * "Overlap" requires both:
 *   1. ≥1 group name in common with the new skill, AND
 *   2. Next-1h fires that intersect at any minute.
 *
 * Pure pre-flight nudge — never blocks registration. False negatives are
 * fine (a `@hourly` skill on a heavily-used group is correct as designed
 * and we don't try to flag it). False positives are the more annoying
 * outcome, so we only warn when both conditions hold simultaneously.
 *
 * Existing schedulers must have been registered with `concurrencyGroups`
 * in their job data — schedulers from before this code shipped will be
 * silently skipped, which means warnings light up only after each skill
 * has been re-registered once (acceptable for a pure ergonomics feature).
 */
export async function findCronOverlaps(
  queue: Queue,
  newSkill: {
    id: string;
    groups: string[];
    triggers: Array<{ pattern: string; tz: string }>;
  },
): Promise<CronOverlapWarning[]> {
  if (newSkill.groups.length === 0 || newSkill.triggers.length === 0) return [];

  let existing: Array<{
    name?: string;
    pattern?: string;
    tz?: string;
    template?: { data?: unknown };
  }>;
  try {
    existing = await queue.getJobSchedulers();
  } catch {
    return [];
  }

  const newGroups = new Set(newSkill.groups);
  const sameJobName = `cron-${newSkill.id.replace(/\//g, "-")}`;
  const warningsByGroup = new Map<string, CronOverlapWarning>();

  for (const sched of existing) {
    // BullMQ's getJobSchedulers() can return entries with undefined fields
    // (sparse-array quirk observed when a scheduler is mid-deletion). Skip
    // any malformed entry rather than crashing the whole register-skill run.
    if (!sched || !sched.name || sched.name === sameJobName) continue;
    if (!sched.pattern) continue;

    const data = sched.template?.data as
      | { skillId?: string; concurrencyGroups?: string[] }
      | undefined;
    if (!data?.skillId || !Array.isArray(data.concurrencyGroups)) continue;

    const sharedGroups = data.concurrencyGroups.filter((g) => newGroups.has(g));
    if (sharedGroups.length === 0) continue;

    const existingFires = nextFireSet(sched.pattern, sched.tz ?? "UTC");
    if (existingFires.size === 0) continue;

    for (const trig of newSkill.triggers) {
      const newFires = nextFireSet(trig.pattern, trig.tz);
      if (newFires.size === 0) continue;
      if (!setsIntersect(existingFires, newFires)) continue;

      for (const group of sharedGroups) {
        const w = warningsByGroup.get(group) ?? {
          group,
          newPattern: trig.pattern,
          conflicts: [],
        };
        if (!w.conflicts.some((c) => c.skillId === data.skillId)) {
          w.conflicts.push({ skillId: data.skillId, pattern: sched.pattern });
        }
        warningsByGroup.set(group, w);
      }
    }
  }

  return [...warningsByGroup.values()];
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

  // Refuse manifests stored on ephemeral paths — they get cleaned up by
  // systemd-tmpfiles or kernel /tmp sweeps, leaving the scheduler firing
  // on a dead repeatable with no observable signal (#172). Operators with
  // a legitimate use (integration tests, throwaway dry-runs) pass
  // `--allow-ephemeral`.
  const absolutePath = resolve(manifestPath);
  if (!ctx.allowEphemeral && isEphemeralPath(absolutePath)) {
    return {
      skillId: manifestPath,
      version: "?",
      registered: 0,
      cleaned: 0,
      status: "error",
      error: `manifest path '${absolutePath}' is ephemeral (under /tmp, /run, /var/tmp, /dev/shm, or $XDG_RUNTIME_DIR). The scheduler would tick forever on a vanishing file. Move it under $NEXAAS_WORKSPACE_ROOT/nexaas-skills/ or pass --allow-ephemeral if you know what you're doing.`,
    };
  }

  let manifest: SkillManifest;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    const raw = yamlLoad(content) as Record<string, unknown> | null;
    manifest = normalizeManifest(raw);
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
  let paProfile: RegisterResult["paProfile"];

  if (!manifest.triggers || manifest.triggers.length === 0) {
    return {
      skillId: manifest.id,
      version: manifest.version,
      registered: 0,
      cleaned: 0,
      status: "no-triggers",
    };
  }

  // PA-as-Router (#122 Wave 1) — when a skill declares an inbound-message
  // trigger with channel_role `pa_reply_<user>`, locate the persona profile
  // at agents/pa/sub-agents/<user>/profile.yaml relative to the manifest's
  // workspace root, validate it, and project its `threads:` block into
  // pa_threads. Hard-fail registration on missing or malformed profile —
  // a PA without a thread declaration would route nothing.
  for (const trigger of manifest.triggers) {
    if (trigger.type !== "inbound-message") continue;
    const userHall = detectPaReplyUser(trigger.channel_role);
    if (!userHall) continue;
    const profilePath = locatePersonaProfile(manifestPath, userHall);
    const loaded = loadPersonaProfile(profilePath);
    if (!loaded.ok) {
      return {
        skillId: manifest.id,
        version: manifest.version,
        registered: 0,
        cleaned: 0,
        status: "error",
        error: `${loaded.error} (expected at ${profilePath})`,
      };
    }
    const summary = await upsertPaThreads(ctx.workspace, userHall, loaded.profile);
    paProfile = { userHall, profilePath, summary };
    break; // one PA profile per skill — first match wins
  }

  // Resolve every cron trigger's effective timezone up-front so the
  // overlap check sees the same tz the scheduler will use.
  const cronTriggers: Array<{ pattern: string; tz: string }> = [];
  for (const trigger of manifest.triggers) {
    if (trigger.type === "cron" && trigger.schedule) {
      cronTriggers.push({
        pattern: trigger.schedule,
        tz:
          trigger.timezone ??
          manifest.timezone ??
          ctx.workspaceTz ??
          process.env.NEXAAS_TIMEZONE ??
          "UTC",
      });
    }
  }

  // Pre-flight cron-overlap warning (#99) — pure ergonomics, never blocks.
  // Quietly empty if the skill has no concurrency_groups or no cron triggers.
  const groups = manifest.concurrency_groups ?? [];
  const warnings = await findCronOverlaps(ctx.queue, {
    id: manifest.id,
    groups,
    triggers: cronTriggers,
  });

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
          // Stored so the next register call's overlap check (#99) can
          // see this skill's groups without re-reading manifests from disk.
          concurrencyGroups: groups,
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
    status: registered > 0 || paProfile ? "registered" : "no-triggers",
    warnings: warnings.length > 0 ? warnings : undefined,
    paProfile,
  };
}

/**
 * Resolve a PA persona profile path from a skill manifest path. Convention:
 *   <workspace_root>/agents/pa/sub-agents/<user>/profile.yaml
 *
 * The skill manifest typically lives somewhere under
 * `<workspace_root>/nexaas-skills/...`, so we walk up to find the workspace
 * root (the nearest ancestor containing `agents/` and `nexaas-skills/`),
 * then descend to the persona path. Falls back to NEXAAS_WORKSPACE_ROOT
 * when set.
 */
function locatePersonaProfile(manifestPath: string, userHall: string): string {
  const explicit = process.env.NEXAAS_WORKSPACE_ROOT;
  if (explicit) {
    return join(explicit, "agents", "pa", "sub-agents", userHall, "profile.yaml");
  }
  let dir = dirname(resolve(manifestPath));
  // Walk up at most 6 levels looking for a workspace-root marker.
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "agents")) && existsSync(join(dir, "nexaas-skills"))) {
      return join(dir, "agents", "pa", "sub-agents", userHall, "profile.yaml");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last-resort guess relative to manifest's dir.
  return join(dirname(resolve(manifestPath)), "..", "..", "..", "agents", "pa", "sub-agents", userHall, "profile.yaml");
}

/** Print a CronOverlapWarning block (used by both single + bulk callers). */
export function printOverlapWarnings(
  warnings: CronOverlapWarning[],
  newSkillId: string,
): void {
  for (const w of warnings) {
    console.log(`  ⚠ Cron overlap on group '${w.group}':`);
    for (const c of w.conflicts) {
      console.log(`      ${c.skillId.padEnd(36)} (${c.pattern})`);
    }
    console.log(`      ${(newSkillId + " [NEW]").padEnd(36)} (${w.newPattern})`);
    console.log(`    These will serialize via the group lock; expect added wait.`);
    console.log(`    Consider offsetting one of them by a few minutes.`);
  }
}

export async function run(args: string[]) {
  // Help flag — pre-#87 this crashed because args[0] was passed straight
  // to readFileSync as a manifest path.
  if (args[0] === "--help" || args[0] === "-h") {
    printUsage();
    return;
  }

  // Strip flags so positional args[0] is the manifest path regardless of
  // ordering. Currently we only support --allow-ephemeral (#172); add to
  // the filter as more flags arrive.
  const allowEphemeral = args.includes("--allow-ephemeral");
  const positional = args.filter((a) => !a.startsWith("--"));
  const manifestPath = positional[0];
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
    const result = await registerOneSkill(resolved, { queue, workspace, workspaceTz, allowEphemeral });

    if (result.status === "error") {
      console.error(`  ✗ ${result.error}`);
      process.exit(1);
    }

    console.log(`\n  Registering skill: ${result.skillId} v${result.version}`);
    if (result.cleaned > 0) {
      console.log(`  Cleaned ${result.cleaned} legacy repeatable(s)`);
    }
    if (result.warnings && result.warnings.length > 0) {
      printOverlapWarnings(result.warnings, result.skillId);
    }
    if (result.paProfile) {
      const { userHall, summary } = result.paProfile;
      const parts: string[] = [];
      if (summary.added.length > 0) parts.push(`${summary.added.length} added`);
      if (summary.updated.length > 0) parts.push(`${summary.updated.length} updated`);
      if (summary.unchanged.length > 0) parts.push(`${summary.unchanged.length} unchanged`);
      if (summary.paused.length > 0) parts.push(`${summary.paused.length} paused`);
      console.log(`  ✓ PA persona '${userHall}' threads: ${parts.join(", ") || "no changes"}`);
    }
    if (result.status === "no-triggers") {
      console.log("  ⚠ No cron triggers found in this manifest");
    } else if (result.registered > 0) {
      console.log(`  ✓ ${result.registered} cron trigger(s) registered`);
    }
    console.log(`\n  Skill registered. Next fire will appear in Bull Board at /queues\n`);
  } finally {
    await connection.quit();
  }
}
