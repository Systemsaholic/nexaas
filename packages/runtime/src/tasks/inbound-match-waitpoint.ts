/**
 * Inbound-match waitpoint primitive (issue #49 Stage 1).
 *
 * Channel-agnostic pattern-matched message capture. A non-skill caller
 * (Python script, shell tool, external CLI) registers a waitpoint with
 * a regex (named pattern or raw) + channel scope; when an inbound drawer
 * matches, the waitpoint resolves and the extracted content is available
 * for polling retrieval.
 *
 * Primary use case surfaced on Phoenix: TD EasyWeb 2FA code delivery via
 * Telegram. Any OAuth/2FA/delivery-token pattern works — channel-agnostic
 * by design (matches on the v0.2 drawer shape, not Telegram-specific fields).
 *
 * Storage: palace dormant drawer at `waitpoints.inbound_match.active`
 * with `dormant_signal = wp_<uuid>`. Survives worker restart; expired
 * waitpoints reaped by the existing waitpoint-reaper task.
 *
 * Integration: the inbound-dispatcher calls `matchDrawerAgainstWaitpoints`
 * for every new `inbox.messaging.*` drawer before fanning out to skills.
 * Match is first-match-wins (ordered by created_at). Skill fanout
 * continues regardless — drawer is observable by both paths.
 */

import { randomUUID } from "crypto";
import { sql, palace, resolveWaitpoint, appendWal } from "@nexaas/palace";
import type { PalaceSession } from "@nexaas/palace";

/** Framework-canonical named patterns. Callers refer by name instead of raw regex. */
const NAMED_PATTERNS: Record<string, string> = {
  digit_code: "\\b\\d{4,8}\\b",
  hex_token: "\\b[0-9a-f]{6,64}\\b",
  url: "https?://\\S+",
  uuid_v4: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
  any: "(?s).+",
};

export type ExtractMode = "first_regex_match" | "first_capture_group" | "full_content";

export interface RegisterParams {
  workspace: string;
  match: {
    /** `inbox.messaging.<room_pattern>` — use exact role or `*` for any. */
    room_pattern?: string;
    /** Named pattern key, or omit in favor of `content_regex`. */
    content_pattern?: keyof typeof NAMED_PATTERNS | string;
    /** Raw regex — requires `raw: true`. */
    content_regex?: string;
    /** Required to use `content_regex` (raw mode). */
    raw?: boolean;
    /** Optional: restrict to drawers where `from` matches this sender id. */
    sender_id?: string;
    /** Regex flags (default: case-insensitive). */
    flags?: string;
  };
  timeout_seconds?: number;
  extract?: ExtractMode;
  /**
   * Adopter-defined tags surfaced to dashboards / UIs as rendering hints
   * (e.g., `["2fa"]`, `["oauth", "google"]`, `["delivery-confirmation"]`).
   * Framework has zero semantics — stored verbatim in waitpoint state and
   * readable via `content::jsonb -> 'tags'`. Dashboards use them to pick
   * input styles, copy, or icons without the framework knowing about any
   * specific category.
   */
  tags?: string[];
}

export interface RegisterResult {
  waitpoint_id: string;
  poll_url: string;
  expires_at: string;
}

export interface StatusResult {
  waitpoint_id: string;
  status: "pending" | "resolved" | "expired" | "cancelled";
  resolved_with?: {
    content: string;
    drawer_id: string;
    matched_at: string;
  };
  expires_at?: string;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Tags that imply the waitpoint will resolve with a credential — 2FA codes,
 * OAuth callbacks, MFA tokens. When any of these appear in `tags` and the
 * caller did not pass `match.sender_id`, the framework emits a non-blocking
 * warning and flags the registration in WAL. The waitpoint is *not* refused —
 * some adopter patterns are legitimately sender-agnostic — but the discipline
 * documented in `docs/adoption-patterns/2fa-code-intercept.md` is now
 * observable instead of honor-system. Match is case-insensitive.
 */
const CREDENTIAL_ADJACENT_TAGS = new Set([
  "2fa", "mfa", "oauth", "2-step", "auth-code", "verification",
]);

// Default cap is 24h. Adopters running state-machine hold patterns (Stripe
// payment-failed, multi-day approval loops) can raise this via env — e.g.
// `NEXAAS_WAITPOINT_MAX_TIMEOUT_DAYS=7`. No added load from longer timeouts;
// the reaper continues to fire whenever each individual waitpoint expires.
// See #66.
const MAX_TIMEOUT_DAYS = (() => {
  const raw = process.env.NEXAAS_WAITPOINT_MAX_TIMEOUT_DAYS;
  if (!raw) return 1;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  // Upper bound so a typo doesn't strand a waitpoint for years.
  return Math.min(parsed, 365);
})();
const MAX_TIMEOUT_SECONDS = Math.floor(MAX_TIMEOUT_DAYS * 24 * 3600);
const MAX_RAW_REGEX_LENGTH = 500;
const MAX_RAW_QUANTIFIERS = 10;

const WAITPOINT_ROOM = { wing: "waitpoints", hall: "inbound_match", room: "active" };

/**
 * Heuristic check against catastrophic-backtracking regexes. Rejects
 * obvious nested-quantifier patterns like `(.*)*`, `(a+)+`, `(.+)+?`.
 * Not a complete defense — users who need real safety should stick to
 * named patterns. Sufficient to keep typos and copy-pastes from wedging
 * the event loop.
 */
function validateRawRegex(pattern: string): { ok: true } | { ok: false; reason: string } {
  if (pattern.length > MAX_RAW_REGEX_LENGTH) {
    return { ok: false, reason: `pattern too long (max ${MAX_RAW_REGEX_LENGTH} chars)` };
  }
  const quantifiers = (pattern.match(/[*+?]/g) ?? []).length;
  if (quantifiers > MAX_RAW_QUANTIFIERS) {
    return { ok: false, reason: `too many quantifiers (max ${MAX_RAW_QUANTIFIERS})` };
  }
  // Nested-quantifier red flag: a group ending in `)` immediately followed
  // by `*` or `+`, where the group itself contains `*`/`+`/`?`.
  if (/\(([^)]*[*+?][^)]*)\)[*+]/.test(pattern)) {
    return { ok: false, reason: "nested quantifiers (catastrophic-backtracking risk)" };
  }
  try { new RegExp(pattern); } catch (err) {
    return { ok: false, reason: `invalid regex: ${(err as Error).message}` };
  }
  return { ok: true };
}

function resolvePattern(match: RegisterParams["match"]): { regex: RegExp } | { error: string } {
  const flags = match.flags ?? "i";
  if (match.content_regex != null && match.raw === true) {
    const check = validateRawRegex(match.content_regex);
    if (!check.ok) return { error: `raw regex rejected: ${check.reason}` };
    try { return { regex: new RegExp(match.content_regex, flags) }; }
    catch (err) { return { error: `invalid regex: ${(err as Error).message}` }; }
  }
  if (match.content_regex != null && match.raw !== true) {
    return { error: "content_regex requires `raw: true` — use a named content_pattern or opt in explicitly" };
  }
  if (match.content_pattern != null) {
    const canon = NAMED_PATTERNS[match.content_pattern];
    if (!canon) {
      return { error: `unknown content_pattern '${match.content_pattern}' — valid: ${Object.keys(NAMED_PATTERNS).join(", ")}` };
    }
    try { return { regex: new RegExp(canon, flags) }; }
    catch (err) { return { error: `named pattern invalid: ${(err as Error).message}` }; }
  }
  return { error: "one of content_pattern or content_regex (with raw: true) is required" };
}

function extractContent(mode: ExtractMode, text: string, regex: RegExp): string | null {
  const match = text.match(regex);
  if (!match) return null;
  if (mode === "full_content") return text;
  if (mode === "first_capture_group") return match[1] ?? match[0];
  return match[0];
}

export async function registerWaitpoint(params: RegisterParams): Promise<RegisterResult | { error: string }> {
  const resolved = resolvePattern(params.match);
  if ("error" in resolved) return { error: resolved.error };

  const timeoutSec = Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(1, params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS),
  );
  const waitpointId = `wp_${randomUUID()}`;
  const extract = params.extract ?? "first_regex_match";
  const session: PalaceSession = palace.enter({ workspace: params.workspace });

  const expiresAt = new Date(Date.now() + timeoutSec * 1000).toISOString();

  // Tags are pure passthrough for downstream UIs — framework reads them
  // only to detect credential-adjacent registrations missing sender_id
  // scope (see CREDENTIAL_ADJACENT_TAGS).
  const tags = Array.isArray(params.tags)
    ? params.tags.filter((t): t is string => typeof t === "string" && t.length > 0).slice(0, 16)
    : undefined;

  // Credential-adjacent + missing sender_id = security gap. Compute the flag
  // up-front (so the WAL payload can record it), but defer the visible warn
  // until after createWaitpoint succeeds — otherwise a creation failure
  // produces a phantom warning for a waitpoint that never existed.
  const credentialAdjacentTagsHit = tags
    ? tags.filter((t) => CREDENTIAL_ADJACENT_TAGS.has(t.toLowerCase()))
    : [];
  const senderIdWarn = credentialAdjacentTagsHit.length > 0 && !params.match.sender_id;

  await session.createWaitpoint({
    signal: waitpointId,
    room: WAITPOINT_ROOM,
    state: {
      waitpoint_id: waitpointId,
      match: {
        room_pattern: params.match.room_pattern ?? "*",
        content_pattern: params.match.content_pattern,
        content_regex: params.match.content_regex,
        raw: params.match.raw === true,
        flags: params.match.flags ?? "i",
        sender_id: params.match.sender_id,
      },
      extract,
      tags,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    },
    timeout: `${timeoutSec}s`,
  });

  // Waitpoint exists — safe to emit the warning. Don't refuse — some patterns
  // (shared admin channels, broadcast confirmations) are legitimately
  // sender-agnostic. Surfaces in console output AND the WAL payload below.
  if (senderIdWarn) {
    console.warn(
      `[nexaas] inbound-match-waitpoint ${waitpointId} registered with credential-adjacent ` +
      `tags (${credentialAdjacentTagsHit.join(", ")}) but no match.sender_id — anyone with ` +
      `adapter write access can resolve this waitpoint with an arbitrary value. Pass ` +
      `match.sender_id to scope to the expected human. ` +
      `See docs/adoption-patterns/2fa-code-intercept.md#security-always-scope-by-sender_id`,
    );
  }

  await appendWal({
    workspace: params.workspace,
    op: "inbound_match_waitpoint_registered",
    actor: "inbound-match-waitpoint",
    payload: {
      waitpoint_id: waitpointId,
      room_pattern: params.match.room_pattern ?? "*",
      content_pattern: params.match.content_pattern,
      content_regex_raw: params.match.raw === true,
      sender_id: params.match.sender_id,
      timeout_seconds: timeoutSec,
      extract,
      tags,
      sender_id_warn: senderIdWarn || undefined,
    },
  });

  return {
    waitpoint_id: waitpointId,
    poll_url: `/api/waitpoints/${waitpointId}`,
    expires_at: expiresAt,
  };
}

interface WaitpointRow {
  id: string;
  workspace: string;
  content: string;
  dormant_signal: string | null;
  dormant_until: string | null;
  created_at: string;
}

async function findByWaitpointId(workspace: string, waitpointId: string): Promise<WaitpointRow | null> {
  // The register path writes a drawer where dormant_signal = waitpoint_id.
  // After resolveWaitpoint, dormant_signal becomes NULL and a superseding
  // resolution drawer is written. Look for either state.
  const rows = await sql<WaitpointRow>(
    `SELECT id, workspace, content, dormant_signal, dormant_until::text AS dormant_until,
            created_at::text AS created_at
       FROM nexaas_memory.events
      WHERE workspace = $1
        AND wing = $2 AND hall = $3 AND room = $4
        AND (dormant_signal = $5 OR content::jsonb ->> 'waitpoint_id' = $5)
      ORDER BY created_at DESC LIMIT 1`,
    [workspace, WAITPOINT_ROOM.wing, WAITPOINT_ROOM.hall, WAITPOINT_ROOM.room, waitpointId],
  );
  return rows[0] ?? null;
}

export async function getWaitpointStatus(workspace: string, waitpointId: string): Promise<StatusResult | null> {
  const row = await findByWaitpointId(workspace, waitpointId);
  if (!row) return null;

  const state = (() => { try { return JSON.parse(row.content); } catch { return {}; } })();

  if (row.dormant_signal === waitpointId) {
    // Still pending — the original registration drawer, not yet resolved.
    // Check timeout manually (reaper hasn't swept yet).
    if (row.dormant_until && new Date(row.dormant_until) < new Date()) {
      return { waitpoint_id: waitpointId, status: "expired", expires_at: row.dormant_until };
    }
    return { waitpoint_id: waitpointId, status: "pending", expires_at: row.dormant_until ?? undefined };
  }

  // dormant_signal cleared — either resolved or cancelled. The resolution
  // drawer written by resolveWaitpoint carries the payload.
  // Look for the newest drawer in this room for this waitpoint's signal.
  const resolutionRows = await sql<WaitpointRow & { resolution_payload: string | null }>(
    `SELECT id, workspace, content AS resolution_payload, created_at::text AS created_at
       FROM nexaas_memory.events
      WHERE workspace = $1
        AND wing = $2 AND hall = $3 AND room = $4
        AND content::jsonb ? 'resolution'
        AND content::jsonb -> 'resolution' ->> 'waitpoint_id' = $5
      ORDER BY created_at DESC LIMIT 1`,
    [workspace, WAITPOINT_ROOM.wing, WAITPOINT_ROOM.hall, WAITPOINT_ROOM.room, waitpointId],
  );
  const resolution = resolutionRows[0];
  if (!resolution) {
    // No resolution drawer — implies cancellation (dormant_signal cleared
    // without resolveWaitpoint firing). Or the waitpoint expired and was
    // reaped. Either way, it's not pending.
    return { waitpoint_id: waitpointId, status: state.cancelled ? "cancelled" : "expired" };
  }
  const payload = (() => { try { return JSON.parse(resolution.resolution_payload ?? "{}"); } catch { return {}; } })();

  return {
    waitpoint_id: waitpointId,
    status: "resolved",
    resolved_with: {
      content: payload.resolution?.extracted ?? "",
      drawer_id: payload.resolution?.drawer_id ?? "",
      matched_at: payload.resolved_at ?? resolution.created_at,
    },
  };
}

export async function cancelWaitpoint(workspace: string, waitpointId: string): Promise<boolean> {
  const row = await findByWaitpointId(workspace, waitpointId);
  if (!row || row.dormant_signal !== waitpointId) return false;

  await sql(
    `UPDATE nexaas_memory.events
        SET dormant_signal = NULL, dormant_until = NULL
      WHERE id = $1`,
    [row.id],
  );
  await appendWal({
    workspace,
    op: "inbound_match_waitpoint_cancelled",
    actor: "inbound-match-waitpoint",
    payload: { waitpoint_id: waitpointId },
  });
  return true;
}

interface InboundDrawer {
  id: string;
  room: string;
  content: string;
  created_at: string;
}

/**
 * First-match-wins check against all open waitpoints for this workspace.
 * Called by the inbound-dispatcher for each new `inbox.messaging.*` drawer.
 * Resolves at most one waitpoint per drawer. Skill fanout continues
 * regardless of match (drawer is observable by both paths).
 */
export async function matchDrawerAgainstWaitpoints(
  workspace: string,
  drawer: InboundDrawer,
): Promise<{ matched: boolean; waitpoint_id?: string }> {
  // Open waitpoints for this workspace, ordered by creation — first-match-wins.
  const openWaitpoints = await sql<WaitpointRow>(
    `SELECT id, workspace, content, dormant_signal,
            dormant_until::text AS dormant_until,
            created_at::text AS created_at
       FROM nexaas_memory.events
      WHERE workspace = $1
        AND wing = $2 AND hall = $3 AND room = $4
        AND dormant_signal IS NOT NULL
      ORDER BY created_at ASC`,
    [workspace, WAITPOINT_ROOM.wing, WAITPOINT_ROOM.hall, WAITPOINT_ROOM.room],
  );

  let drawerPayload: Record<string, unknown>;
  try { drawerPayload = JSON.parse(drawer.content); } catch { drawerPayload = {}; }
  const drawerText = typeof drawerPayload.content === "string" ? drawerPayload.content : drawer.content;
  // `from` per messaging-inbound v0.2 is an object { id, name?, username? }.
  // Some adapters may write a flat string for simpler channels (SMS, email).
  // Accept both shapes — extract .id when object, use directly when string.
  const drawerFromRaw = drawerPayload.from as unknown;
  const drawerFrom =
    typeof drawerFromRaw === "string"
      ? drawerFromRaw
      : (drawerFromRaw && typeof drawerFromRaw === "object" && typeof (drawerFromRaw as { id?: unknown }).id === "string")
        ? (drawerFromRaw as { id: string }).id
        : undefined;

  for (const wp of openWaitpoints) {
    let state: Record<string, unknown>;
    try { state = JSON.parse(wp.content); } catch { continue; }
    const match = state.match as Record<string, unknown> | undefined;
    if (!match) continue;

    // Room scope check. `*` or missing matches any inbox.messaging.* room.
    const roomPattern = typeof match.room_pattern === "string" ? match.room_pattern : "*";
    if (roomPattern !== "*" && roomPattern !== drawer.room) continue;

    // Sender scope check.
    if (typeof match.sender_id === "string" && match.sender_id && drawerFrom !== match.sender_id) continue;

    // Rebuild the regex (it's not serializable through JSON so we store
    // the constituents and reconstruct).
    let regex: RegExp;
    try {
      const flags = typeof match.flags === "string" ? match.flags : "i";
      let pattern: string | null = null;
      if (typeof match.content_regex === "string" && match.raw === true) {
        pattern = match.content_regex;
      } else if (typeof match.content_pattern === "string") {
        pattern = NAMED_PATTERNS[match.content_pattern] ?? null;
      }
      if (!pattern) continue;
      regex = new RegExp(pattern, flags);
    } catch { continue; }

    const extractMode = (typeof state.extract === "string" ? state.extract : "first_regex_match") as ExtractMode;
    const extracted = extractContent(extractMode, drawerText, regex);
    if (extracted == null) continue;

    // Match! Resolve the waitpoint with the extracted content.
    try {
      await resolveWaitpoint(
        wp.dormant_signal!,
        {
          waitpoint_id: wp.dormant_signal!,
          extracted,
          drawer_id: drawer.id,
          channel_role: drawer.room,
        },
        `inbound-match:${drawer.id}`,
      );
      await appendWal({
        workspace,
        op: "inbound_match_waitpoint_resolved",
        actor: "inbound-match-waitpoint",
        payload: {
          waitpoint_id: wp.dormant_signal!,
          drawer_id: drawer.id,
          channel_role: drawer.room,
          extract_mode: extractMode,
          extracted_length: extracted.length,
        },
      });
      return { matched: true, waitpoint_id: wp.dormant_signal! };
    } catch (err) {
      // Resolve failed (already resolved / race with another poller).
      // Continue scanning — maybe another waitpoint matches.
      await appendWal({
        workspace,
        op: "inbound_match_resolve_failed",
        actor: "inbound-match-waitpoint",
        payload: {
          waitpoint_id: wp.dormant_signal!,
          drawer_id: drawer.id,
          error: (err as Error).message.slice(0, 200),
        },
      });
      continue;
    }
  }

  return { matched: false };
}

export function listNamedPatterns(): string[] {
  return Object.keys(NAMED_PATTERNS);
}
