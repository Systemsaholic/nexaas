/**
 * Helpers for the `/api/skills/trigger` HTTP endpoint (#83).
 *
 * The peer of `nexaas trigger-skill` for non-CLI callers (Nexmatic
 * dashboard "send now" buttons, external webhooks, dashboard manual
 * re-runs). Same auth posture as `/api/waitpoints/inbound-match`:
 * `bearerAuth()` if `NEXAAS_CROSS_VPS_BEARER_TOKEN` is set, otherwise
 * pass-through (localhost-only deployments where the dashboard runs on
 * the same VPS).
 *
 * The actual Express route lives in `packages/runtime/src/worker.ts`
 * so it sits next to its peers (`/api/waitpoints/*`, `/api/drawers/*`).
 * This module owns the bits that benefit from being testable without
 * spinning up Express:
 *
 * - skill_id → manifest path resolution with path-traversal protection
 * - manifest load + id-vs-id consistency check
 * - request-body validation
 *
 * The `executeTrigger()` orchestrator wires those helpers together and
 * the actual queue.add() so the route handler stays a thin shim.
 */

import { existsSync, readFileSync } from "fs";
import { resolve, sep } from "path";
import { load as yamlLoad } from "js-yaml";
import { randomUUID } from "crypto";

export interface TriggerInput {
  skillId: string;
  workspace?: string;
  payload?: Record<string, unknown>;
  actor?: string;
  idempotencyKey?: string;
}

export type TriggerError =
  | { status: 400; error: string }
  | { status: 404; error: string };

export interface TriggerSuccess {
  status: 202;
  body: {
    ok: true;
    data: {
      runId: string;
      queueJobId: string | undefined;
    };
  };
}

export type TriggerOutcome = TriggerError | TriggerSuccess;

export interface ManifestSlim {
  id: string;
  version: string;
  execution?: { type?: string };
}

/** Canonical manifest filenames in resolution order. `skill.yaml` is the
 *  legacy framework name; `contract.yaml` is the format register-skill
 *  accepts natively as of #139/#141. Both are valid storage shapes — the
 *  trigger lookup needs to find whichever one the skill author ships. */
const MANIFEST_FILENAMES = ["skill.yaml", "contract.yaml"] as const;

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

export function loadSkillManifest(path: string): ManifestSlim | null {
  if (!existsSync(path)) return null;
  try {
    const m = yamlLoad(readFileSync(path, "utf-8")) as ManifestSlim;
    if (!m?.id || !m?.version) return null;
    return m;
  } catch {
    return null;
  }
}

export function validateTriggerInput(input: unknown): TriggerInput | TriggerError {
  if (!input || typeof input !== "object") {
    return { status: 400, error: "request body must be a JSON object" };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.skillId !== "string" || obj.skillId.length === 0) {
    return { status: 400, error: "skillId is required" };
  }
  if (obj.workspace !== undefined && typeof obj.workspace !== "string") {
    return { status: 400, error: "workspace must be a string when provided" };
  }
  if (obj.actor !== undefined && typeof obj.actor !== "string") {
    return { status: 400, error: "actor must be a string when provided" };
  }
  if (obj.idempotencyKey !== undefined && typeof obj.idempotencyKey !== "string") {
    return { status: 400, error: "idempotencyKey must be a string when provided" };
  }
  if (obj.payload !== undefined && (obj.payload === null || typeof obj.payload !== "object" || Array.isArray(obj.payload))) {
    return { status: 400, error: "payload must be a JSON object when provided" };
  }
  return {
    skillId: obj.skillId,
    workspace: obj.workspace as string | undefined,
    payload: obj.payload as Record<string, unknown> | undefined,
    actor: obj.actor as string | undefined,
    idempotencyKey: obj.idempotencyKey as string | undefined,
  };
}

export interface ExecuteDeps {
  workspaceRoot: string;
  defaultWorkspace: string | undefined;
  enqueue: (queueName: string, jobName: string, data: unknown, opts: { jobId: string }) => Promise<{ id: string | undefined }>;
  audit: (entry: {
    workspace: string;
    op: string;
    actor: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * The end-to-end trigger flow: validate → resolve manifest → enqueue
 * → audit. Handler in worker.ts is just `res.status(out.status).json(out.body)`.
 */
export async function executeTrigger(
  input: TriggerInput,
  deps: ExecuteDeps,
): Promise<TriggerOutcome> {
  const workspace = input.workspace ?? deps.defaultWorkspace;
  if (!workspace) {
    return { status: 400, error: "workspace is required (or set NEXAAS_WORKSPACE on the worker)" };
  }

  const manifestPath = resolveSkillManifestPath(input.skillId, deps.workspaceRoot);
  if (!manifestPath) {
    return { status: 400, error: `invalid skillId: must match [a-zA-Z0-9_-]+(\\/[a-zA-Z0-9_-]+)*` };
  }

  const manifest = loadSkillManifest(manifestPath);
  if (!manifest) {
    return { status: 404, error: `skill not found at ${manifestPath} — register it first via 'nexaas register-skill'` };
  }
  if (manifest.id !== input.skillId) {
    return {
      status: 400,
      error: `manifest id mismatch — file declares '${manifest.id}', request asked for '${input.skillId}'`,
    };
  }

  const runId = randomUUID();
  const sanitizedSkillId = manifest.id.replace(/\//g, "-");
  // BullMQ jobIds dedupe within retention. With idempotencyKey supplied,
  // repeated POSTs collapse to the same job; without, each request gets
  // a unique id (but the runId in the response identifies the run either
  // way).
  const jobId = input.idempotencyKey
    ? `manual-${sanitizedSkillId}-${input.idempotencyKey}`
    : `manual-${sanitizedSkillId}-${runId}`;

  const enqueued = await deps.enqueue(
    `nexaas-skills-${workspace}`,
    "skill-step",
    {
      workspace,
      runId,
      skillId: manifest.id,
      skillVersion: manifest.version,
      stepId: manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec",
      triggerType: "manual",
      triggerPayload: input.payload ?? {},
      manifestPath,
    },
    { jobId },
  );

  // Audit. Best-effort: if WAL append fails, the job is already enqueued
  // and the caller should still get the runId — we surface the audit
  // failure in the WAL layer's own logging, not as a request error.
  try {
    await deps.audit({
      workspace,
      op: "skill_trigger_http",
      actor: input.actor ?? "http-trigger",
      payload: {
        skill_id: manifest.id,
        run_id: runId,
        job_id: enqueued.id ?? null,
        idempotency_key: input.idempotencyKey ?? null,
      },
    });
  } catch (err) {
    console.error("[nexaas] skill_trigger_http audit emit failed:", err);
  }

  return {
    status: 202,
    body: {
      ok: true,
      data: { runId, queueJobId: enqueued.id },
    },
  };
}
