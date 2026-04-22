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
import type { WorkspaceManifest, ChannelBinding } from "../schemas/workspace-manifest.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 5;
const POLL_BATCH_SIZE = 25;
const MCP_CALL_TIMEOUT_MS = 15_000;

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

function parseEnvelope(content: string): DispatchEnvelope | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.idempotency_key !== "string" || typeof parsed.channel_role !== "string") {
      return null;
    }
    return parsed as unknown as DispatchEnvelope;
  } catch { return null; }
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
    const sendInput: Record<string, unknown> = {
      to: envelope.to ?? binding.config?.to ?? binding.config?.chat_id ?? binding.config?.channel,
      content: envelope.content ?? "",
    };
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
      "summary", "payload_preview", "decisions", "channel_kind",
      "channel_mcp", "channel_config", "on_timeout",
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

export async function dispatchPendingNotifications(
  workspace: string,
  workspaceManifest: WorkspaceManifest | null,
): Promise<{ dispatched: number; failed: number; skipped: number }> {
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

  return { dispatched, failed, skipped };
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
      if (result.dispatched > 0 || result.failed > 0) {
        console.log(
          `[nexaas] Notification dispatcher: ${result.dispatched} delivered, ${result.failed} failed, ${result.skipped} skipped`,
        );
      }
    } catch (err) {
      console.error("[nexaas] notification dispatcher error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Notification dispatcher started (polling every ${interval / 1000}s)`);
}

export function stopNotificationDispatcher(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
