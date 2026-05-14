/**
 * Outbound notification dispatcher (issue #40 Stage 1).
 *
 * Polls `notifications.pending.*` drawers every N seconds. For each
 * pending drawer:
 *
 *   1. Extract the framework-canonical dispatch envelope from the
 *      drawer payload — idempotency_key, channel_role, content, etc.
 *   2. Claim the dispatch in `notification_dispatches` via INSERT ...
 *      ON CONFLICT DO NOTHING so retries never double-post.
 *   3. Resolve channel_role → {kind, mcp, config} against the workspace
 *      manifest (from #41).
 *   4. Invoke the bound MCP's `send` tool (messaging-outbound v0.2 per #38).
 *   5. On success: write receipt drawer to notifications.delivered.<kind>.<role>,
 *      update dispatch row with channel_message_id.
 *   6. On failure: write notifications.failed.<kind>.<role>, mark row
 *      failed (retried on next poll until max attempts).
 *
 * Fail-open on missing manifest / missing binding — logs a WAL warning
 * and skips the dispatch rather than halting the worker. Framework-integrity:
 * works identically for direct adopters (Phoenix) and operator-managed
 * workspaces (Nexmatic); no billing, plan, or tier assumption.
 */

import { sql, appendWal, palace } from "@nexaas/palace";
import { McpClient, loadMcpConfigs } from "../mcp/client.js";
import { loadWorkspaceManifest } from "../schemas/load-manifest.js";
import { resolvePaRoutingVersion, type WorkspaceManifest, type ChannelBinding } from "../schemas/workspace-manifest.js";
import { reportMissingRelation } from "./_consistency-warning.js";
import {
  detectPaNotifyUser,
  defaultPaNotifyDeps,
  executePaNotify,
  type PaNotifyInput,
} from "../api/pa-notify.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 5;
const POLL_BATCH_SIZE = 25;
const MCP_CALL_TIMEOUT_MS = 15_000;
/**
 * How long a `claimed` row may sit before the reaper considers the
 * original claimer dead and resets it to `failed` for retry. Must
 * comfortably exceed `MCP_CALL_TIMEOUT_MS` plus typical worker-restart
 * latency. See #94. Two minutes leaves headroom for slow MCP responses
 * and orderly systemd restarts without false positives.
 */
const STALE_CLAIM_INTERVAL = "2 minutes";

interface PendingDrawer {
  id: string;
  workspace: string;
  wing: string;
  hall: string;
  room: string;
  content: string;
  created_at: string;
}

interface DispatchEnvelope {
  idempotency_key: string;
  channel_role: string;
  // Everything else is passed through to the send tool. The framework
  // guarantees parse_mode / inline_buttons / reply_to shapes per
  // messaging-outbound v0.2 (#38), but skill authors supply the content.
  content?: string;
  parse_mode?: string;
  inline_buttons?: Array<{ text: string; button_id: string }>;
  reply_to?: string;
  to?: string;  // optional override; usually derived from channel binding config
  // Hold the dispatch until a wall-clock time (ISO-8601). Unset → send ASAP.
  // Past → send now. Future → dispatcher skips this tick; drawer re-polled
  // next tick. See #65.
  send_after?: string;
  [extra: string]: unknown;
}

let _polling = false;
let _interval: NodeJS.Timeout | null = null;

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render an approval-request drawer into channel-shaped fields.
 *
 * TAG (#45 Stage 1a) writes approval drawers with structured fields
 * (`summary`, `payload_full`, `payload_preview`, `decisions`) and no
 * `content` — the dispatcher must translate them into something a
 * channel adapter can render. Without this step the dispatcher forwards
 * `content: ""` and Telegram (and presumably any adapter) rejects empty
 * messages, retries 5×, and the approval prompt is never delivered (#93).
 *
 * Email-shape detection: when `payload_full` carries `{to, subject, body}`
 * we render a proper email preview using `<blockquote>` for the body —
 * not `<pre>`, because a code block makes prose unreadable and the
 * JSON-stringified `payload_preview` shows literal `\n` and escaped
 * quotes. Other payload shapes fall back to `<pre>{payload_preview}</pre>`.
 *
 * `decisions[{id, label}]` → `inline_buttons[{text: label, button_id: id}]`
 * matches what `approval-resolver` validates against (`click.button_id`
 * is checked against the recorded `decisionIds`).
 */
function renderApprovalRequest(envelope: DispatchEnvelope): {
  content: string;
  parse_mode: string;
  inline_buttons?: Array<{ text: string; button_id: string }>;
} {
  const summary = typeof envelope.summary === "string" ? envelope.summary : "";
  const payloadFull = envelope.payload_full as Record<string, unknown> | undefined;
  const payloadPreview = typeof envelope.payload_preview === "string"
    ? envelope.payload_preview
    : "";

  const isEmailPayload =
    payloadFull != null &&
    typeof payloadFull.to === "string" &&
    typeof payloadFull.subject === "string" &&
    typeof payloadFull.body === "string";

  const lead = summary ? `${htmlEscape(summary)}\n\n` : "";
  let content: string;
  if (isEmailPayload && payloadFull != null) {
    const to = htmlEscape(payloadFull.to as string);
    const subject = htmlEscape(payloadFull.subject as string);
    const body = htmlEscape(payloadFull.body as string);
    content =
      `${lead}` +
      `<b>To:</b> ${to}\n` +
      `<b>Subject:</b> ${subject}\n\n` +
      `<blockquote>${body}</blockquote>`;
  } else {
    content = `${lead}<pre>${htmlEscape(payloadPreview)}</pre>`;
  }

  let buttons: Array<{ text: string; button_id: string }> | undefined;
  const decisionsRaw = envelope.decisions;
  if (Array.isArray(decisionsRaw)) {
    buttons = decisionsRaw
      .filter((d): d is { id?: unknown; label?: unknown } => d !== null && typeof d === "object")
      .map((d) => ({
        text: typeof d.label === "string" ? d.label : String(d.id ?? "?"),
        button_id: typeof d.id === "string" ? d.id : String(d.id ?? ""),
      }))
      .filter((b) => b.button_id !== "");
    if (buttons.length === 0) buttons = undefined;
  }

  return { content, parse_mode: "HTML", inline_buttons: buttons };
}

function parseEnvelope(content: string): DispatchEnvelope | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.idempotency_key !== "string" || typeof parsed.channel_role !== "string") {
      return null;
    }
    return parsed as unknown as DispatchEnvelope;
  } catch { return null; }
}

/**
 * Reset stuck-`claimed` rows back to `failed` so the normal retry path
 * picks them up. See #94 — when the worker is restarted (or crashed)
 * mid-dispatch, the row is left at `status='claimed'` indefinitely
 * because the in-flight MCP `send` was killed before the dispatcher's
 * try/finally reached `markDelivered` / `markFailed`. `selectPending`
 * only considers `NULL` or `failed` rows, so stuck `claimed` rows are
 * invisible to subsequent polls without this sweep.
 *
 * Returns the number of rows reaped (for the WAL emit). Best-effort —
 * a single failed sweep doesn't halt the rest of the tick.
 */
async function reapStaleClaims(workspace: string): Promise<number> {
  const reaped = await sql<{ idempotency_key: string }>(
    `UPDATE nexaas_memory.notification_dispatches
        SET status = 'failed',
            last_error = COALESCE(last_error, $2)
      WHERE workspace = $1
        AND status = 'claimed'
        AND claimed_at < now() - INTERVAL '${STALE_CLAIM_INTERVAL}'
      RETURNING idempotency_key`,
    [workspace, "reaped: claimed row exceeded stale threshold"],
  );
  return reaped.length;
}

async function selectPending(workspace: string): Promise<PendingDrawer[]> {
  // Pick pending drawers whose idempotency_key hasn't successfully
  // delivered yet. We LEFT JOIN on notification_dispatches so drawers
  // with a 'delivered' row are filtered out, and ones with a 'failed'
  // row below MAX_ATTEMPTS come back into the batch for retry.
  return await sql<PendingDrawer>(
    `SELECT e.id, e.workspace, e.wing, e.hall, e.room, e.content, e.created_at
       FROM nexaas_memory.events e
       LEFT JOIN nexaas_memory.notification_dispatches d
              ON d.workspace = e.workspace
             AND d.idempotency_key = (e.content::jsonb ->> 'idempotency_key')
      WHERE e.workspace = $1
        AND e.wing = 'notifications'
        AND e.hall = 'pending'
        AND e.dormant_signal IS NULL
        AND (d.status IS NULL OR (d.status = 'failed' AND d.attempts < $2))
      ORDER BY e.created_at ASC
      LIMIT $3`,
    [workspace, MAX_ATTEMPTS, POLL_BATCH_SIZE],
  );
}

async function claim(
  workspace: string,
  envelope: DispatchEnvelope,
  drawerId: string,
  binding: ChannelBinding | undefined,
): Promise<"claimed" | "already_delivered" | "retry"> {
  // Atomic claim. ON CONFLICT targets the primary key; if a prior row
  // exists, we inspect its status to decide whether to retry.
  const existing = await sql<{ status: string; attempts: number }>(
    `INSERT INTO nexaas_memory.notification_dispatches
        (workspace, idempotency_key, channel_role, channel_kind, channel_mcp,
         drawer_id, status, attempts, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'claimed', 1, now())
     ON CONFLICT (workspace, idempotency_key) DO UPDATE
        SET status = CASE WHEN nexaas_memory.notification_dispatches.status = 'delivered'
                          THEN nexaas_memory.notification_dispatches.status
                          ELSE 'claimed' END,
            attempts = nexaas_memory.notification_dispatches.attempts + 1,
            claimed_at = CASE WHEN nexaas_memory.notification_dispatches.status = 'delivered'
                              THEN nexaas_memory.notification_dispatches.claimed_at
                              ELSE now() END
     RETURNING status, attempts`,
    [
      workspace,
      envelope.idempotency_key,
      envelope.channel_role,
      binding?.kind ?? null,
      binding?.mcp ?? null,
      drawerId,
    ],
  );
  const row = existing[0];
  if (!row) return "retry";
  if (row.status === "delivered") return "already_delivered";
  return "claimed";
}

async function markDelivered(
  workspace: string,
  idempotencyKey: string,
  channelMessageId: string | null,
): Promise<void> {
  await sql(
    `UPDATE nexaas_memory.notification_dispatches
        SET status = 'delivered',
            channel_message_id = $3,
            delivered_at = now(),
            last_error = NULL
      WHERE workspace = $1 AND idempotency_key = $2`,
    [workspace, idempotencyKey, channelMessageId],
  );
}

async function markFailed(workspace: string, idempotencyKey: string, err: string): Promise<void> {
  await sql(
    `UPDATE nexaas_memory.notification_dispatches
        SET status = 'failed', last_error = $3
      WHERE workspace = $1 AND idempotency_key = $2`,
    [workspace, idempotencyKey, err.slice(0, 1000)],
  );
}

async function dispatchViaMcp(
  workspace: string,
  binding: ChannelBinding,
  envelope: DispatchEnvelope,
): Promise<{ channel_message_id: string | null }> {
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT ?? process.env.HOME ?? "/opt/nexaas";
  const configs = loadMcpConfigs(workspaceRoot);
  const config = configs[binding.mcp];
  if (!config) {
    throw new Error(`MCP '${binding.mcp}' not found in workspace .mcp.json`);
  }

  const client = new McpClient(binding.mcp, config);
  try {
    await client.connect();

    // Framework v0.2 messaging-outbound.send shape (#38). Strip the
    // envelope's framework-internal fields before forwarding to the MCP.
    // Anything in `extra` that the skill author left on the drawer passes
    // through as-is — channel adapters may use it (e.g., Telegram
    // disable_notification) but the framework doesn't touch it.
    // `to` is derived from binding.config if the envelope didn't supply one.
    //
    // Approval-request drawers (#45 Stage 1a) carry no `content` — TAG
    // writes structured fields and expects the dispatcher to render them.
    // Without this branch the adapter receives `content: ""` and rejects
    // the send; see #93.
    const renderedApproval =
      envelope.kind === "approval_request" && !envelope.content
        ? renderApprovalRequest(envelope)
        : null;

    const sendInput: Record<string, unknown> = {
      to: envelope.to ?? binding.config?.to ?? binding.config?.chat_id ?? binding.config?.channel,
      content: renderedApproval ? renderedApproval.content : (envelope.content ?? ""),
    };
    if (renderedApproval) {
      sendInput.parse_mode = renderedApproval.parse_mode;
      if (renderedApproval.inline_buttons) {
        sendInput.inline_buttons = renderedApproval.inline_buttons;
      }
    }
    // Envelope-supplied overrides win over rendered defaults.
    if (envelope.parse_mode != null) sendInput.parse_mode = envelope.parse_mode;
    if (envelope.inline_buttons) sendInput.inline_buttons = envelope.inline_buttons;
    if (envelope.reply_to != null) sendInput.reply_to = envelope.reply_to;

    // Forward any other envelope fields that aren't framework-reserved.
    const reserved = new Set([
      "idempotency_key", "channel_role", "content", "parse_mode",
      "inline_buttons", "reply_to", "to", "send_after",
      // TAG approval-request drawer fields (#45 Stage 1a) — don't forward
      // these to the MCP; they're for the subscriber's own context.
      "kind", "run_id", "step_id", "waitpoint_signal", "output_id",
      "summary", "payload_preview", "payload_full", "decisions",
      "handlers", "skill_id", "channel_kind", "channel_mcp",
      "channel_config", "on_timeout",
    ]);
    for (const [k, v] of Object.entries(envelope)) {
      if (!reserved.has(k)) sendInput[k] = v;
    }

    const raw = await Promise.race([
      client.callTool("send", sendInput),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP 'send' timed out after ${MCP_CALL_TIMEOUT_MS}ms`)), MCP_CALL_TIMEOUT_MS),
      ),
    ]);

    // MCP tool responses are text per the Anthropic MCP protocol. Some
    // adapters return structured JSON; try to parse a channel_message_id.
    let channelMessageId: string | null = null;
    try {
      const parsed = JSON.parse(raw);
      channelMessageId = (parsed.channel_native_id ?? parsed.message_id ?? parsed.id)?.toString() ?? null;
    } catch { /* raw text, leave channelMessageId null */ }

    return { channel_message_id: channelMessageId };
  } finally {
    try { await client.disconnect(); } catch { /* best effort */ }
  }
}

async function writeOutcomeDrawer(
  workspace: string,
  kind: "delivered" | "failed",
  envelope: DispatchEnvelope,
  binding: ChannelBinding | undefined,
  extra: Record<string, unknown>,
): Promise<void> {
  const channelKind = binding?.kind ?? "unknown";
  const session = palace.enter({ workspace });
  const room = {
    wing: "notifications",
    hall: kind,
    room: `${channelKind}.${envelope.channel_role.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
  };
  await session.writeDrawer(
    room,
    JSON.stringify({
      kind,
      idempotency_key: envelope.idempotency_key,
      channel_role: envelope.channel_role,
      channel_kind: binding?.kind,
      channel_mcp: binding?.mcp,
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

/**
 * PA-as-Router rewire path (#126 Wave 5 §5.1). Returns:
 *   "delivered"          — rewire succeeded; caller marks the dispatch claimed+delivered
 *   "already_delivered"  — claim short-circuited (concurrent dispatcher tick)
 *   "fallthrough"        — user not yet migrated to v2 OR no default thread; fall back to direct path
 *
 * Map legacy envelope → PaNotifyInput:
 *   content                  → content
 *   parse_mode (HTML/Markd…) → content_format
 *   channel_role pa_notify_X → user X, default thread_id "inbox"
 *   idempotency_key          → idempotency_key
 *   kind/urgency defaults    → "alert" / "normal" (legacy drawers carry neither)
 */
async function tryPaRewire(
  workspace: string,
  manifest: WorkspaceManifest | null,
  drawer: PendingDrawer,
  envelope: DispatchEnvelope,
  paUser: string,
): Promise<"delivered" | "already_delivered" | "fallthrough"> {
  // Wave 5 cutover flag — workspace-manifest pa_routing controls whether
  // this user's envelopes get rewired (v2) or stay on the legacy direct
  // path (v1). Per-user override lets ops stagger a canary without
  // flipping every PA at once. See RFC-0002 §9.
  if (resolvePaRoutingVersion(manifest, paUser) === "v1") {
    await appendWal({
      workspace,
      op: "pa_rewire_skipped",
      actor: "notification-dispatcher",
      payload: {
        drawer_id: drawer.id,
        channel_role: envelope.channel_role,
        user: paUser,
        reason: "v1_pinned",
      },
    });
    return "fallthrough";
  }

  // Cheap pre-check: does the user have any active threads at all? If not,
  // they haven't been migrated to v2 — keep going on the direct path.
  const activeCount = await sql<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM nexaas_memory.pa_threads
      WHERE workspace = $1 AND user_hall = $2 AND status = 'active'`,
    [workspace, paUser],
  );
  if (Number(activeCount[0]?.n ?? "0") === 0) {
    return "fallthrough";
  }

  // No content → fall through to the legacy path. The dispatcher's
  // renderApprovalRequest() runs there for approval-shaped envelopes; we
  // don't reimplement that mapping in the rewire path.
  if (!envelope.content) {
    return "fallthrough";
  }

  const mappedFormat: PaNotifyInput["contentFormat"] =
    envelope.parse_mode === "MarkdownV2" || envelope.parse_mode === "Markdown"
      ? "markdown"
      : envelope.parse_mode === "HTML"
        ? "html"
        : "html";

  // Map legacy `inline_buttons[{text, button_id}]` → v2 `actions[{label, button_id}]`.
  // Without this, legacy `send_telegram_sync(buttons=...)` callers (e.g.
  // Phoenix's join-webhook) silently lost their approval buttons after
  // the PA-Router rewire — content arrived as a passive alert and the
  // downstream skill waiting on the button reply never got a path
  // forward. See #153.
  const mappedActions = envelope.inline_buttons
    ?.filter((b) => b && b.button_id && b.text)
    .map((b) => ({ label: b.text, button_id: b.button_id }));

  const input: PaNotifyInput = {
    user: paUser,
    threadId: "inbox",      // default fallback bucket per RFC Wave 5 §5.1 mapping
    urgency: "normal",
    // Switch to "approval" when actions are present so the receiver
    // renders the decision UI instead of a passive alert.
    // validatePaNotifyInput() enforces "actions required when kind=approval".
    kind: mappedActions && mappedActions.length > 0 ? "approval" : "alert",
    content: envelope.content,
    contentFormat: mappedFormat,
    idempotencyKey: envelope.idempotency_key,
    ...(mappedActions && mappedActions.length > 0 ? { actions: mappedActions } : {}),
  };

  let outcome;
  try {
    outcome = await executePaNotify(input, defaultPaNotifyDeps(workspace));
  } catch (err) {
    // Rewire blew up (DB transient, etc.). Don't lose the notification —
    // emit a warning and fall through. The direct path will retry next tick.
    await appendWal({
      workspace,
      op: "pa_rewire_error",
      actor: "notification-dispatcher",
      payload: {
        drawer_id: drawer.id,
        channel_role: envelope.channel_role,
        error: (err as Error).message.slice(0, 500),
      },
    });
    return "fallthrough";
  }

  if ("error" in outcome) {
    // 404 thread_not_found ("inbox" not declared) → fall through to direct
    // path so the user still gets the notification while ops fixes the
    // profile. WAL it so the misconfig is observable.
    await appendWal({
      workspace,
      op: "pa_rewire_skipped",
      actor: "notification-dispatcher",
      payload: {
        drawer_id: drawer.id,
        channel_role: envelope.channel_role,
        user: paUser,
        reason: outcome.error,
        details: outcome.details ?? null,
      },
    });
    return "fallthrough";
  }

  // Rewire succeeded. Record the dispatch claim+delivered against the
  // framework idempotency_key so the existing reaper / poll filter sees
  // the row as done.
  const claimResult = await claim(workspace, envelope, drawer.id, {
    kind: "pa-router",
    mcp: "pa-notify-endpoint",
    config: {},
  } as ChannelBinding);
  if (claimResult === "already_delivered") {
    return "already_delivered";
  }

  await markDelivered(workspace, envelope.idempotency_key, outcome.body.data.notification_id);
  await appendWal({
    workspace,
    op: "notification_delivered_via_pa",
    actor: "notification-dispatcher",
    payload: {
      drawer_id: drawer.id,
      idempotency_key: envelope.idempotency_key,
      channel_role: envelope.channel_role,
      user: paUser,
      thread_id: outcome.body.data.thread_id,
      notification_id: outcome.body.data.notification_id,
      idempotency_hit: outcome.body.data.idempotency_hit,
    },
  });
  return "delivered";
}

export async function dispatchPendingNotifications(
  workspace: string,
  workspaceManifest: WorkspaceManifest | null,
): Promise<{ dispatched: number; failed: number; skipped: number; reaped: number }> {
  // Reap stuck-`claimed` rows from prior worker deaths (#94) before the
  // poll, so they become eligible for `selectPending` on this same tick
  // rather than waiting another interval.
  let reaped = 0;
  try {
    reaped = await reapStaleClaims(workspace);
    if (reaped > 0) {
      await appendWal({
        workspace,
        op: "notification_reaped",
        actor: "notification-dispatcher",
        payload: { count: reaped, threshold: STALE_CLAIM_INTERVAL },
      });
    }
  } catch (err) {
    // Best-effort: log but don't halt the tick. A failed reap leaves
    // stale rows for the next interval to clean up.
    console.error("[nexaas] notification reaper error:", err);
  }

  const pending = await selectPending(workspace);
  let dispatched = 0, failed = 0, skipped = 0;

  for (const drawer of pending) {
    const envelope = parseEnvelope(drawer.content);
    if (!envelope) {
      skipped++;
      await appendWal({
        workspace,
        op: "notification_skipped",
        actor: "notification-dispatcher",
        payload: {
          drawer_id: drawer.id,
          reason: "missing idempotency_key or channel_role",
        },
      });
      continue;
    }

    // send_after: hold until wall-clock time (#65). Future → leave drawer
    // alone and try again next tick. No WAL write, no claim — the drawer
    // is simply not-yet-due. Malformed send_after falls through to send-now
    // (loud failure preferable to silent indefinite wait).
    if (envelope.send_after) {
      const dueAt = Date.parse(envelope.send_after);
      if (Number.isFinite(dueAt) && dueAt > Date.now()) {
        continue;
      }
    }

    // PA-as-Router rewire (RFC-0002 §3.2, Wave 5 §5.1, #126). When the
    // envelope targets a user's PA via `channel_role: pa_notify_<user>`
    // AND that user has declared persona threads (Wave 1 #122), route
    // through the PA notify endpoint in-process instead of direct telegram
    // dispatch. Users without declared threads keep the legacy direct path
    // unchanged — the migration is opt-in by declaring a persona profile.
    const paUser = detectPaNotifyUser(envelope.channel_role);
    if (paUser) {
      const rewired = await tryPaRewire(workspace, workspaceManifest, drawer, envelope, paUser);
      if (rewired === "delivered") {
        dispatched++;
        continue;
      }
      if (rewired === "already_delivered") {
        skipped++;
        continue;
      }
      // "fallthrough" → user has no active threads OR rewire 404'd on a
      // missing default thread. Drop through to the legacy direct path
      // below so we don't lose the notification while the canary catches
      // up the profile.
    }

    // Channel binding resolution — fail-open: log + skip if missing.
    const binding = workspaceManifest?.channel_bindings?.[envelope.channel_role] as
      ChannelBinding | undefined;
    if (!binding) {
      skipped++;
      await appendWal({
        workspace,
        op: "notification_skipped",
        actor: "notification-dispatcher",
        payload: {
          drawer_id: drawer.id,
          channel_role: envelope.channel_role,
          reason: "no channel_binding in workspace manifest",
        },
      });
      continue;
    }

    const claimResult = await claim(workspace, envelope, drawer.id, binding);
    if (claimResult === "already_delivered") {
      skipped++;
      continue;
    }

    try {
      const { channel_message_id } = await dispatchViaMcp(workspace, binding, envelope);
      await markDelivered(workspace, envelope.idempotency_key, channel_message_id);
      await writeOutcomeDrawer(workspace, "delivered", envelope, binding, {
        channel_message_id,
        source_drawer_id: drawer.id,
      });
      await appendWal({
        workspace,
        op: "notification_delivered",
        actor: "notification-dispatcher",
        payload: {
          drawer_id: drawer.id,
          idempotency_key: envelope.idempotency_key,
          channel_role: envelope.channel_role,
          channel_kind: binding.kind,
          channel_message_id,
        },
      });
      dispatched++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markFailed(workspace, envelope.idempotency_key, msg);
      await writeOutcomeDrawer(workspace, "failed", envelope, binding, {
        error: msg.slice(0, 500),
        source_drawer_id: drawer.id,
      });
      await appendWal({
        workspace,
        op: "notification_failed",
        actor: "notification-dispatcher",
        payload: {
          drawer_id: drawer.id,
          idempotency_key: envelope.idempotency_key,
          channel_role: envelope.channel_role,
          error: msg.slice(0, 500),
        },
      });
      failed++;
    }
  }

  return { dispatched, failed, skipped, reaped };
}

export function startNotificationDispatcher(
  workspace: string,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      // Fresh manifest read each tick — framework fail-open per #41.
      const { manifest } = await loadWorkspaceManifest(workspace);
      const result = await dispatchPendingNotifications(workspace, manifest);
      if (result.dispatched > 0 || result.failed > 0 || result.reaped > 0) {
        console.log(
          `[nexaas] Notification dispatcher: ${result.dispatched} delivered, ${result.failed} failed, ${result.skipped} skipped, ${result.reaped} reaped`,
        );
      }
    } catch (err) {
      const handled = await reportMissingRelation(workspace, "notification-dispatcher", err);
      if (!handled) console.error("[nexaas] notification dispatcher error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Notification dispatcher started (polling every ${interval / 1000}s)`);
}

/**
 * Test-only export of the approval-request renderer. Underscore prefix
 * marks it as not part of the public surface; consumers should not rely
 * on this. See `scripts/test-approval-render-93.mjs` for usage.
 */
export const _renderApprovalRequest = renderApprovalRequest;

/**
 * Test-only export of the stale-claim reaper. Same convention as above.
 * See `scripts/test-stale-claim-reaper-94.mjs` for usage.
 */
export const _reapStaleClaims = reapStaleClaims;

export function stopNotificationDispatcher(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
