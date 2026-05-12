/**
 * Persona profile schema for PA conversation-turn skills (RFC-0002, #122).
 *
 * A persona profile lives at the workspace's agents/pa/sub-agents/<user>/profile.yaml
 * and declares the small fixed set of domain-scoped threads the PA owns
 * (e.g. `hr`, `accounting`, `marketing`). Profile data is the authoritative
 * source; `pa_threads` rows in the palace are a denormalized projection
 * upserted at skill-registration time.
 *
 * This module owns:
 *   - The Zod schema (`PersonaProfileSchema`) — exact shape validation
 *   - `loadPersonaProfile(profilePath)` — read + parse + validate
 *   - `upsertPaThreads(workspace, userHall, profile)` — projection to DB
 *
 * The CLI's `register-skill` calls these when a skill manifest declares an
 * inbound-message trigger with channel_role `pa_reply_<user>` — the profile
 * must exist and validate, or registration fails loudly.
 */

import { existsSync, readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { z } from "zod";
import { sql } from "@nexaas/palace";

/**
 * Thread id is a slug — lowercase + digit + underscore, must start with a
 * letter/underscore. Constrained so it can be embedded in URLs, channel
 * roles, and palace room names without escaping.
 */
const THREAD_ID_RE = /^[a-z_][a-z0-9_]*$/;

/** Maximum threads per persona — RFC §1: "small fixed set ≤ 5 typical". */
export const MAX_THREADS_PER_PERSONA = 8;

export const PersonaThreadSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(THREAD_ID_RE, "thread id must match /^[a-z_][a-z0-9_]*$/"),
  display: z.string().min(1).max(64),
  /**
   * Hints for the inference fallback (RFC §3.4) when an inbound has no
   * explicit `message_thread_id` / `reply_to_message_id`. Not enforcement —
   * the classifier can still place a message in `hr` even if no alias matched.
   */
  domain_aliases: z.array(z.string().min(1).max(40)).default([]),
});

export const PersonaProfileSchema = z.object({
  threads: z
    .array(PersonaThreadSchema)
    .min(1, "persona profile must declare at least one thread")
    .max(MAX_THREADS_PER_PERSONA, `persona profile may declare at most ${MAX_THREADS_PER_PERSONA} threads`)
    .superRefine((threads, ctx) => {
      const seen = new Set<string>();
      threads.forEach((t, i) => {
        if (seen.has(t.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "id"],
            message: `duplicate thread id '${t.id}'`,
          });
        }
        seen.add(t.id);
      });
    }),
});

export type PersonaThread = z.infer<typeof PersonaThreadSchema>;
export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;

export interface ProfileLoadError {
  ok: false;
  error: string;
}

export interface ProfileLoadOk {
  ok: true;
  profile: PersonaProfile;
}

export type ProfileLoadResult = ProfileLoadOk | ProfileLoadError;

/**
 * Read + parse + validate a persona profile. Pure (no DB I/O); pair with
 * `upsertPaThreads` to project into the palace.
 *
 * The profile YAML may carry other top-level keys (avatar, voice, system_prompt,
 * etc.) we don't validate here — we extract only the framework-owned `threads:`
 * block. Workspace-side persona authors keep ownership of the rest.
 */
export function loadPersonaProfile(profilePath: string): ProfileLoadResult {
  if (!existsSync(profilePath)) {
    return { ok: false, error: `persona profile not found at '${profilePath}'` };
  }
  let raw: unknown;
  try {
    raw = yamlLoad(readFileSync(profilePath, "utf-8"));
  } catch (err) {
    return { ok: false, error: `persona profile parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "persona profile must be a YAML mapping" };
  }
  // Pluck the threads field only; ignore other persona-author fields.
  const threadsField = (raw as Record<string, unknown>).threads;
  const parsed = PersonaProfileSchema.safeParse({ threads: threadsField });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.length > 0 ? `threads[${issue.path.join("][")}]` : "threads";
    return { ok: false, error: `${path}: ${issue.message}` };
  }
  return { ok: true, profile: parsed.data };
}

/**
 * Idempotent projection of a persona profile into `pa_threads`. Threads
 * present in the profile are upserted (display + aliases refreshed); threads
 * previously declared but now absent are marked `status='paused'` rather
 * than deleted (preserves audit + channel_target so a re-add re-uses the
 * existing topic).
 *
 * Returns a summary of what changed for the caller to surface.
 */
export interface UpsertSummary {
  added: string[];     // new thread ids
  updated: string[];   // thread ids whose display/aliases changed
  unchanged: string[]; // thread ids already in desired state
  paused: string[];    // previously declared, now absent
}

export async function upsertPaThreads(
  workspace: string,
  userHall: string,
  profile: PersonaProfile,
): Promise<UpsertSummary> {
  const desired = new Map(profile.threads.map((t) => [t.id, t]));

  // Snapshot existing active rows so we can detect adds/updates/pauses
  // without N+1 round trips.
  const existing = await sql<{
    thread_id: string;
    display_name: string;
    domain_aliases: string[] | null;
    status: string;
  }>(
    `SELECT thread_id, display_name, domain_aliases, status
       FROM nexaas_memory.pa_threads
      WHERE workspace = $1 AND user_hall = $2`,
    [workspace, userHall],
  );
  const existingMap = new Map(existing.map((r) => [r.thread_id, r]));

  const summary: UpsertSummary = { added: [], updated: [], unchanged: [], paused: [] };

  for (const [id, thread] of desired) {
    const prior = existingMap.get(id);
    if (!prior) {
      await sql(
        `INSERT INTO nexaas_memory.pa_threads
           (workspace, user_hall, thread_id, display_name, domain_aliases, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [workspace, userHall, id, thread.display, thread.domain_aliases],
      );
      summary.added.push(id);
      continue;
    }
    const aliasesEqual =
      (prior.domain_aliases ?? []).length === thread.domain_aliases.length &&
      (prior.domain_aliases ?? []).every((a, i) => a === thread.domain_aliases[i]);
    const displayEqual = prior.display_name === thread.display;
    const statusActive = prior.status === "active";
    if (aliasesEqual && displayEqual && statusActive) {
      summary.unchanged.push(id);
      continue;
    }
    await sql(
      `UPDATE nexaas_memory.pa_threads
          SET display_name = $4,
              domain_aliases = $5,
              status = 'active'
        WHERE workspace = $1 AND user_hall = $2 AND thread_id = $3`,
      [workspace, userHall, id, thread.display, thread.domain_aliases],
    );
    summary.updated.push(id);
  }

  // Pause threads that exist in the DB but are no longer in the profile.
  // Don't delete — keeps channel_target intact in case the operator re-adds.
  for (const [id, prior] of existingMap) {
    if (desired.has(id) || prior.status !== "active") continue;
    await sql(
      `UPDATE nexaas_memory.pa_threads
          SET status = 'paused'
        WHERE workspace = $1 AND user_hall = $2 AND thread_id = $3`,
      [workspace, userHall, id],
    );
    summary.paused.push(id);
  }

  return summary;
}

/**
 * Heuristic to detect a "this skill is a PA conversation-turn" trigger.
 *
 * Matches `inbound-message` triggers whose channel_role starts with
 * `pa_reply_` — the convention established for PA skills today. Returns
 * the user portion (e.g. `pa_reply_alice` → `alice`) or null.
 *
 * Kept generous so future convention tweaks (e.g. `pa_reply.<user>` dot
 * form) can be added here without spreading the heuristic across callers.
 */
export function detectPaReplyUser(channelRole: string | undefined): string | null {
  if (!channelRole) return null;
  const m = /^pa_reply[_.]([a-z0-9][a-z0-9_-]*)$/.exec(channelRole);
  return m ? m[1]! : null;
}
