/**
 * @nexaas/manifest — the skill manifest's single source of truth (#256).
 *
 * Registration (`nexaas register-skill`), validation (`dry-run`), library
 * packaging, HTTP triggering (`/api/skills/trigger`), and BullMQ execution
 * all consume THIS module, so a manifest accepted at registration time is
 * guaranteed to mean the same thing at execution time. Before the
 * extraction, five-plus independent parsers each re-derived a subset of the
 * shape — #246 (registered contract.yaml skills 404'd on trigger) was one
 * instance of that class, and the BullMQ worker executing contract.yaml
 * skills with `manifest.id = undefined` was the next one waiting.
 *
 * Leaf package: depends only on js-yaml + zod. Both @nexaas/cli and
 * @nexaas/runtime import it; it must never import them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { load as yamlLoad } from "js-yaml";
import { z } from "zod";

// ── Shape ────────────────────────────────────────────────────────────────

export interface RoomRef {
  wing: string;
  hall: string;
  room: string;
}

export interface SkillTrigger {
  type: string;
  schedule?: string;
  timezone?: string;
  /** for type=inbound-message; e.g. "pa_reply_<user>" */
  channel_role?: string;
  /** for type=batch */
  bucket?: string;
  fire_when?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SkillExecution {
  type: string;
  command?: string;
  /** MILLISECONDS (contract.yaml's `timeout_seconds` is converted on load). */
  timeout?: number;
  working_directory?: string;
  model_tier?: string;
  preflight?: {
    command: string;
    timeout?: number;
    working_directory?: string;
  };
  primary_output?: string;
  [key: string]: unknown;
}

export interface SkillLimits {
  max_turns?: number;
  max_spend_usd?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_output_tokens_per_turn?: number;
  max_consecutive_identical_tool_calls?: number;
  max_consecutive_errors?: number;
}

export interface SkillOutput {
  id: string;
  kind?: string;
  routing_default?: string;
  approval?: Record<string, unknown>;
  notify?: { channel_role: string; timeout?: string };
  verify?: Record<string, unknown>;
  required?: boolean;
  parse_mode?: "plain" | "markdown" | "html";
  overridable?: boolean;
  [key: string]: unknown;
}

/**
 * The normalized manifest. Executors keep their own richer views
 * (`AiSkillManifest`, `ShellSkillManifest` in @nexaas/runtime) — this is
 * the shared superset every consumer can rely on after `normalizeManifest`.
 * Unknown adopter/product fields (`produces:`, `tag_defaults:`, …) pass
 * through untouched.
 */
export interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  timezone?: string;
  concurrency_groups?: string[];
  triggers?: SkillTrigger[];
  execution?: SkillExecution;
  mcp_servers?: Array<string | { id: string; tools?: string[] }>;
  rooms?: {
    primary?: RoomRef;
    retrieval_rooms?: RoomRef[];
  };
  outputs?: SkillOutput[];
  limits?: SkillLimits;
  self_reflection?: boolean;
  [key: string]: unknown;
}

// ── Zod schema ───────────────────────────────────────────────────────────

const roomRefSchema = z.object({
  wing: z.string(),
  hall: z.string(),
  room: z.string(),
});

/**
 * Structural validation for a NORMALIZED manifest. Everything beyond
 * id/version is optional — presence requirements (execution.type, prompt.md
 * for ai-skills, …) are caller policy (`dry-run` enforces the strictest
 * set). `.passthrough()` at every level: adopters ship extra fields.
 */
export const skillManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    timezone: z.string().optional(),
    concurrency_groups: z.array(z.string()).optional(),
    triggers: z
      .array(z.object({ type: z.string() }).passthrough())
      .optional(),
    execution: z
      .object({
        type: z.string(),
        command: z.string().optional(),
        timeout: z.number().optional(),
        working_directory: z.string().optional(),
        model_tier: z.string().optional(),
      })
      .passthrough()
      .optional(),
    mcp_servers: z
      .array(
        z.union([
          z.string(),
          z.object({ id: z.string(), tools: z.array(z.string()).optional() }).passthrough(),
        ]),
      )
      .optional(),
    rooms: z
      .object({
        primary: roomRefSchema.optional(),
        retrieval_rooms: z.array(roomRefSchema).optional(),
      })
      .passthrough()
      .optional(),
    outputs: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    limits: z
      .object({
        max_turns: z.number().optional(),
        max_spend_usd: z.number().optional(),
        max_input_tokens: z.number().optional(),
        max_output_tokens: z.number().optional(),
        max_output_tokens_per_turn: z.number().optional(),
        max_consecutive_identical_tool_calls: z.number().optional(),
        max_consecutive_errors: z.number().optional(),
      })
      .passthrough()
      .optional(),
    self_reflection: z.boolean().optional(),
  })
  .passthrough();

/**
 * Validate a normalized manifest's structure. Returns human-readable
 * issues ("triggers.0.type: Required"), empty when valid.
 */
export function validateManifestShape(manifest: unknown): string[] {
  const result = skillManifestSchema.safeParse(manifest);
  if (result.success) return [];
  return result.error.issues.map((i) =>
    i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
  );
}

// ── Normalization (moved verbatim from cli/register-skill.ts, #139) ─────

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
 * Pure helper: no I/O, no side effects.
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
      ...execIn,
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

// ── Loader ───────────────────────────────────────────────────────────────

/**
 * Read + parse + normalize a manifest file. THE way to get a manifest off
 * disk — every consumer sees identical id/trigger/timeout semantics
 * regardless of whether the author shipped skill.yaml or contract.yaml.
 *
 * Throws on unreadable files and invalid YAML (same surface as the raw
 * `yamlLoad(readFileSync(...))` it replaces — callers keep their existing
 * error handling). Returns `{}`-shaped manifest for empty/non-object
 * documents, matching `normalizeManifest(null)`.
 */
export function loadManifest(path: string): SkillManifest {
  const raw = yamlLoad(readFileSync(path, "utf-8"));
  return normalizeManifest(
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null,
  );
}

/** Canonical manifest filenames in resolution order. `skill.yaml` is the
 *  legacy framework name; `contract.yaml` is the format register-skill
 *  accepts natively as of #139/#141. */
export const MANIFEST_FILENAMES = ["skill.yaml", "contract.yaml"] as const;

/**
 * Resolve a skill_id into an absolute manifest path under the workspace's
 * skills root, rejecting any input that would escape the root.
 *
 * Returns the first existing manifest file from MANIFEST_FILENAMES at
 * `<root>/nexaas-skills/<category>/<name>/`. Falls back to the first
 * candidate (skill.yaml) if neither exists so the caller's 404 message
 * names a sensible path. Returns null only for path-traversal attempts
 * (caller surfaces a 400).
 */
/**
 * Walk `<skillsRoot>/<category>/<name>/` two levels deep and return one
 * manifest path per skill directory, preferring skill.yaml over
 * contract.yaml (same order as MANIFEST_FILENAMES / the trigger path).
 * Replaces five near-identical private walkers (scheduler reconcile,
 * manifest index, inbound/batch dispatchers, staleness watchdog) that
 * had each hardcoded skill.yaml only.
 */
export function findManifestPaths(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];
  for (const category of readdirSync(skillsRoot)) {
    const catPath = join(skillsRoot, category);
    try { if (!statSync(catPath).isDirectory()) continue; } catch { continue; }
    for (const name of readdirSync(catPath)) {
      const skillPath = join(catPath, name);
      try { if (!statSync(skillPath).isDirectory()) continue; } catch { continue; }
      for (const filename of MANIFEST_FILENAMES) {
        const candidate = join(skillPath, filename);
        if (existsSync(candidate)) { out.push(candidate); break; }
      }
    }
  }
  return out;
}

export function resolveSkillManifestPath(
  skillId: string,
  workspaceRoot: string,
): string | null {
  // Tighten input shape — alphanumeric segments separated by `/`, no `..`,
  // no leading slash, no embedded NULs.
  if (!/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/.test(skillId)) return null;

  const skillsRoot = resolve(workspaceRoot, "nexaas-skills");
  const skillDir = resolve(skillsRoot, skillId);

  // Defense in depth — even though the regex above blocks `..`, verify
  // the resolved path is genuinely under the skills root before touching
  // the filesystem. Catches e.g. symlinked categories.
  if (!skillDir.startsWith(skillsRoot + sep)) return null;

  for (const filename of MANIFEST_FILENAMES) {
    const candidate = resolve(skillDir, filename);
    if (existsSync(candidate)) return candidate;
  }
  // Neither variant exists — return the legacy name so the 404 message
  // points operators at the conventional location.
  return resolve(skillDir, MANIFEST_FILENAMES[0]);
}
