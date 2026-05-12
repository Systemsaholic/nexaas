/**
 * Helpers for the `POST /api/pa/<user>/notify` HTTP endpoint
 * (RFC-0002 §3.2, Wave 2 §2.1, #123).
 *
 * Skills route user-facing notifications through the addressee's PA via
 * this endpoint instead of writing directly to a channel queue. The PA
 * owns thread placement, urgency policy, rendering, and audit (RFC §3.2).
 *
 * This module owns the framework-side primitives that are testable without
 * spinning up Express:
 *
 *   - Request validation (Zod-shaped, but kept hand-rolled to avoid pulling
 *     Zod into the worker boot path; mirrors the skills-trigger style)
 *   - Thread resolution against `pa_threads` (#122)
 *   - Idempotency dedup against recent `notifications.pending.pa-routed.*`
 *     drawers
 *   - Audit drawer + pending-routed drawer emit
 *
 * Per-thread BullMQ queue infrastructure (RFC Wave 2 §2.2) is deliberately
 * deferred to a follow-up. The PA's conversation-turn skill consumes the
 * pending drawer via its existing inbound-message trigger — same path as
 * inbox messages today, so no new dispatcher is required to start landing
 * notifications.
 *
 * Auth posture matches `/api/skills/trigger` and `/api/waitpoints/*`:
 * `bearerAuth()` if `NEXAAS_CROSS_VPS_BEARER_TOKEN` is set, open otherwise.
 */

import { randomUUID } from "crypto";
import { sql, appendWal } from "@nexaas/palace";

export type Urgency = "immediate" | "normal" | "low";
export type Kind = "alert" | "approval" | "digest";

export interface PaNotifyInput {
  user: string;             // url path param — addressee
  threadId: string;
  urgency: Urgency;
  kind: Kind;
  content: string;
  contentFormat?: "html" | "text" | "markdown";
  originatingSkill?: string;
  actions?: Array<{ button_id: string; label: string }>;
  waitpointId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export type PaNotifyError =
  | { status: 400; error: string; details?: unknown }
  | { status: 404; error: string; details?: unknown };

export interface PaNotifySuccess {
  status: 202;
  body: {
    ok: true;
    data: {
      notification_id: string;
      queued: true;
      thread_id: string;
      idempotency_hit: boolean;       // true when dedup short-circuited
    };
  };
}

export type PaNotifyOutcome = PaNotifyError | PaNotifySuccess;

const USER_RE = /^[a-z0-9][a-z0-9_-]*$/;
const THREAD_ID_RE = /^[a-z_][a-z0-9_]*$/;
const URGENCIES: Urgency[] = ["immediate", "normal", "low"];
const KINDS: Kind[] = ["alert", "approval", "digest"];
const MAX_CONTENT_LEN = 8192;
const MAX_ACTION_LABEL = 80;
const MAX_IDEM_KEY = 200;

/**
 * Hand-rolled input validation. Returns the parsed shape on success or a
 * 400 error with a path-prefixed message on failure (matches the
 * skills-trigger style — one error at a time, fix-as-you-go).
 *
 * `user` is the URL path param; the rest comes from the JSON body.
 */
export function validatePaNotifyInput(
  user: string,
  body: unknown,
): PaNotifyInput | PaNotifyError {
  if (!USER_RE.test(user)) {
    return { status: 400, error: "user path param must match /^[a-z0-9][a-z0-9_-]*$/" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, error: "request body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;

  if (typeof obj.thread_id !== "string" || !THREAD_ID_RE.test(obj.thread_id)) {
    return { status: 400, error: "thread_id is required and must match /^[a-z_][a-z0-9_]*$/" };
  }
  if (typeof obj.urgency !== "string" || !URGENCIES.includes(obj.urgency as Urgency)) {
    return { status: 400, error: `urgency must be one of: ${URGENCIES.join(", ")}` };
  }
  if (typeof obj.kind !== "string" || !KINDS.includes(obj.kind as Kind)) {
    return { status: 400, error: `kind must be one of: ${KINDS.join(", ")}` };
  }
  if (typeof obj.content !== "string" || obj.content.length === 0) {
    return { status: 400, error: "content is required (non-empty string)" };
  }
  if (obj.content.length > MAX_CONTENT_LEN) {
    return { status: 400, error: `content exceeds ${MAX_CONTENT_LEN}-char limit` };
  }
  if (obj.content_format !== undefined &&
      !["html", "text", "markdown"].includes(obj.content_format as string)) {
    return { status: 400, error: "content_format must be one of: html, text, markdown" };
  }
  if (obj.originating_skill !== undefined && typeof obj.originating_skill !== "string") {
    return { status: 400, error: "originating_skill must be a string when provided" };
  }
  if (obj.idempotency_key !== undefined) {
    if (typeof obj.idempotency_key !== "string" || obj.idempotency_key.length > MAX_IDEM_KEY) {
      return { status: 400, error: `idempotency_key must be a string ≤ ${MAX_IDEM_KEY} chars` };
    }
  }
  if (obj.expires_at !== undefined && typeof obj.expires_at !== "string") {
    return { status: 400, error: "expires_at must be an ISO 8601 string when provided" };
  }
  if (obj.metadata !== undefined &&
      (obj.metadata === null || typeof obj.metadata !== "object" || Array.isArray(obj.metadata))) {
    return { status: 400, error: "metadata must be a JSON object when provided" };
  }

  // Actions — required for kind=approval, must each have button_id + label
  let actions: Array<{ button_id: string; label: string }> | undefined;
  if (obj.actions !== undefined) {
    if (!Array.isArray(obj.actions)) {
      return { status: 400, error: "actions must be an array when provided" };
    }
    actions = [];
    for (const [i, a] of obj.actions.entries()) {
      if (!a || typeof a !== "object") {
        return { status: 400, error: `actions[${i}]: must be an object` };
      }
      const ao = a as Record<string, unknown>;
      if (typeof ao.button_id !== "string" || ao.button_id.length === 0) {
        return { status: 400, error: `actions[${i}].button_id is required` };
      }
      if (typeof ao.label !== "string" || ao.label.length === 0) {
        return { status: 400, error: `actions[${i}].label is required` };
      }
      if (ao.label.length > MAX_ACTION_LABEL) {
        return { status: 400, error: `actions[${i}].label exceeds ${MAX_ACTION_LABEL}-char limit` };
      }
      actions.push({ button_id: ao.button_id, label: ao.label });
    }
  }

  if (obj.kind === "approval") {
    if (typeof obj.waitpoint_id !== "string" || obj.waitpoint_id.length === 0) {
      return { status: 400, error: "waitpoint_id is required when kind='approval'" };
    }
    if (!actions || actions.length === 0) {
      return { status: 400, error: "actions must contain at least one entry when kind='approval'" };
    }
  } else if (obj.waitpoint_id !== undefined && typeof obj.waitpoint_id !== "string") {
    return { status: 400, error: "waitpoint_id must be a string when provided" };
  }

  return {
    user,
    threadId: obj.thread_id,
    urgency: obj.urgency as Urgency,
    kind: obj.kind as Kind,
    content: obj.content,
    contentFormat: obj.content_format as PaNotifyInput["contentFormat"],
    originatingSkill: obj.originating_skill as string | undefined,
    actions,
    waitpointId: obj.waitpoint_id as string | undefined,
    idempotencyKey: obj.idempotency_key as string | undefined,
    expiresAt: obj.expires_at as string | undefined,
    metadata: obj.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Single active thread row — what we need to confirm the address is real
 * and to surface a useful 404 list when it isn't.
 */
export interface ActiveThreadRow {
  thread_id: string;
  display_name: string;
}

export interface ExecuteDeps {
  workspace: string;
  /**
   * Return the list of active threads for (workspace, user). Used both to
   * verify the requested thread exists and to populate the 404 payload's
   * `available_threads` hint when it doesn't.
   */
  listActiveThreads: (workspace: string, user: string) => Promise<ActiveThreadRow[]>;
  /**
   * Idempotency lookup. Returns the original `notification_id` if a row
   * with the same idempotency_key was emitted in the last 1 h and is not
   * yet resolved; null otherwise. The caller owns the lookback window.
   */
  findRecentByIdempotency: (workspace: string, user: string, key: string) => Promise<string | null>;
  /**
   * Write the pending-routed drawer (the queue surface the PA consumes via
   * its inbound-message trigger). Returns the drawer id (used as
   * notification_id).
   */
  writePendingDrawer: (entry: {
    workspace: string;
    user: string;
    threadId: string;
    notificationId: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Write the audit drawer to `inbox/<user>/notifications-emitted`. The PA
   * can answer "what notifications did <user> receive in the last 24h" by
   * querying this room alone (RFC Wave 2 §2.5).
   */
  writeAuditDrawer: (entry: {
    workspace: string;
    user: string;
    notificationId: string;
    threadId: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * End-to-end PA notify flow:
 *   1. Resolve user's active threads
 *   2. 404 if requested thread isn't among them
 *   3. Idempotency check — return original notification_id on hit
 *   4. Mint notification_id + write pending-routed drawer (PA picks up)
 *   5. Best-effort audit drawer
 */
export async function executePaNotify(
  input: PaNotifyInput,
  deps: ExecuteDeps,
): Promise<PaNotifyOutcome> {
  const threads = await deps.listActiveThreads(deps.workspace, input.user);
  const matching = threads.find((t) => t.thread_id === input.threadId);
  if (!matching) {
    return {
      status: 404,
      error: "thread_not_found",
      details: {
        user: input.user,
        requested_thread: input.threadId,
        available_threads: threads.map((t) => ({ id: t.thread_id, display: t.display_name })),
      },
    };
  }

  // Idempotency — repeated POSTs with the same key collapse to one notification.
  if (input.idempotencyKey) {
    const prior = await deps.findRecentByIdempotency(deps.workspace, input.user, input.idempotencyKey);
    if (prior) {
      return {
        status: 202,
        body: {
          ok: true,
          data: {
            notification_id: prior,
            queued: true,
            thread_id: input.threadId,
            idempotency_hit: true,
          },
        },
      };
    }
  }

  const notificationId = `n-${randomUUID()}`;
  const corePayload: Record<string, unknown> = {
    notification_id: notificationId,
    user: input.user,
    thread_id: input.threadId,
    urgency: input.urgency,
    kind: input.kind,
    content: input.content,
    content_format: input.contentFormat ?? "html",
    originating_skill: input.originatingSkill ?? null,
    actions: input.actions ?? null,
    waitpoint_id: input.waitpointId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    expires_at: input.expiresAt ?? null,
    metadata: input.metadata ?? null,
    received_at: new Date().toISOString(),
  };

  await deps.writePendingDrawer({
    workspace: deps.workspace,
    user: input.user,
    threadId: input.threadId,
    notificationId,
    payload: corePayload,
  });

  try {
    await deps.writeAuditDrawer({
      workspace: deps.workspace,
      user: input.user,
      notificationId,
      threadId: input.threadId,
      payload: {
        ...corePayload,
        delivery_status: "queued",
      },
    });
  } catch (err) {
    console.error("[nexaas] pa-notify audit drawer write failed (non-fatal):", err);
  }

  return {
    status: 202,
    body: {
      ok: true,
      data: {
        notification_id: notificationId,
        queued: true,
        thread_id: input.threadId,
        idempotency_hit: false,
      },
    },
  };
}

/**
 * Build the SQL-backed deps object used by the worker route and the
 * notifications-dispatcher rewire (Wave 5 §5.1, #126). Single source of
 * truth for the dedup window, drawer rooms, and WAL emit so both call sites
 * stay in lockstep.
 */
export function defaultPaNotifyDeps(workspace: string): ExecuteDeps {
  return {
    workspace,
    listActiveThreads: async (ws, user) => {
      return await sql<{ thread_id: string; display_name: string }>(
        `SELECT thread_id, display_name
           FROM nexaas_memory.pa_threads
          WHERE workspace = $1 AND user_hall = $2 AND status = 'active'
          ORDER BY thread_id`,
        [ws, user],
      );
    },
    findRecentByIdempotency: async (ws, user, key) => {
      const rows = await sql<{ content: string }>(
        `SELECT content FROM nexaas_memory.events
          WHERE workspace = $1
            AND wing = 'notifications' AND hall = 'pending'
            AND room LIKE 'pa-routed.%'
            AND created_at > now() - interval '1 hour'
            AND content::jsonb ->> 'idempotency_key' = $2
            AND content::jsonb ->> 'user' = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [ws, key, user],
      );
      if (rows.length === 0) return null;
      try {
        const c = JSON.parse(rows[0]!.content);
        return typeof c.notification_id === "string" ? c.notification_id : null;
      } catch {
        return null;
      }
    },
    writePendingDrawer: async (entry) => {
      await sql(
        `INSERT INTO nexaas_memory.events
           (workspace, wing, hall, room, content, content_hash, event_type, agent_id, metadata, normalize_version)
         VALUES ($1, 'notifications', 'pending', $2, $3,
                 encode(digest($3, 'sha256'), 'hex'), 'drawer', 'pa-notify-endpoint',
                 $4, 1)`,
        [
          entry.workspace,
          `pa-routed.${entry.threadId}`,
          JSON.stringify(entry.payload),
          JSON.stringify({ user: entry.user, thread_id: entry.threadId, notification_id: entry.notificationId }),
        ],
      );
    },
    writeAuditDrawer: async (entry) => {
      await sql(
        `INSERT INTO nexaas_memory.events
           (workspace, wing, hall, room, content, content_hash, event_type, agent_id, metadata, normalize_version)
         VALUES ($1, 'inbox', $2, 'notifications-emitted', $3,
                 encode(digest($3, 'sha256'), 'hex'), 'drawer', 'pa-notify-endpoint',
                 $4, 1)`,
        [
          entry.workspace,
          entry.user,
          JSON.stringify(entry.payload),
          JSON.stringify({ notification_id: entry.notificationId, thread_id: entry.threadId }),
        ],
      );
      await appendWal({
        workspace: entry.workspace,
        op: "pa_notify_received",
        actor: "pa-notify-endpoint",
        payload: {
          user: entry.user,
          thread_id: entry.threadId,
          notification_id: entry.notificationId,
        },
      });
    },
  };
}

/**
 * Convention parser. Matches `pa_notify_<user>` and `pa_notify.<user>`
 * channel-role forms used by skills that target a user's PA. Returns the
 * user portion (e.g. `pa_notify_alice` → `alice`) or null.
 *
 * Mirrors `detectPaReplyUser` from persona-profile but for outbound
 * `pa_notify_*` rather than inbound `pa_reply_*`. Kept narrow so the
 * dispatcher rewire only catches roles it should rewrite.
 */
export function detectPaNotifyUser(channelRole: string | undefined): string | null {
  if (!channelRole) return null;
  const m = /^pa_notify[_.]([a-z0-9][a-z0-9_-]*)$/.exec(channelRole);
  return m ? m[1]! : null;
}
