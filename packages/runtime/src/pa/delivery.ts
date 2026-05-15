/**
 * PA-Router outbound delivery helpers — claim/ack primitives backed by
 * the pa_delivery_marker sidecar table.
 *
 * Workspace delivery skills (channel adapters that turn a pa-routed
 * pending drawer into a Telegram message, email, etc.) call
 * `claimNextDelivery` to atomically lease the next pending drawer for
 * a thread, do their outbound work, and report back via
 * `markDeliverySent` / `markDeliveryFailed`. Concurrency model:
 *
 *   - Per-thread serialization: SELECT … FOR UPDATE SKIP LOCKED on a
 *     row keyed by (workspace, user_hall, thread_id) means concurrent
 *     consumers for the same thread queue up; only one wins each tick.
 *   - Cross-thread parallelism: different threads claim different
 *     rows, so they don't contend for the same lock.
 *   - At-least-once: a crashed consumer leaves a 'claimed' row;
 *     `reapStaleDeliveryClaims` resets it back to 'failed' for
 *     re-pickup after a configurable lease interval.
 *
 * Workspace consumers written before these helpers can migrate at
 * their own cadence — helpers are opt-in and operate against the same
 * table schema. The framework writes 'queued' rows; consumers using
 * the old query patterns continue to work.
 */

import { sql, sqlOne, appendWal } from "@nexaas/palace";

/** Max retries before a delivery hits terminal 'dead' state. */
const MAX_RETRIES = (() => {
  const raw = parseInt(process.env.NEXAAS_PA_MAX_RETRIES ?? "3", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();

/** Stale-claim threshold. A 'claimed' row older than this is assumed to be
 *  abandoned by a dead consumer and gets reset to 'failed' for re-pickup. */
const STALE_CLAIM_INTERVAL = "2 minutes";

export interface DeliveryClaim {
  workspace: string;
  drawer_id: string;
  user_hall: string;
  thread_id: string;
  retries: number;
  /** Raw drawer content JSON. Consumer parses to its own envelope shape. */
  envelope: string;
}

/**
 * Insert a marker row for a pending delivery. Idempotent — re-running
 * with the same drawer_id is a no-op (allows the caller to safely
 * retry after a transient db failure).
 */
export async function enqueueDelivery(
  workspace: string,
  drawer_id: string,
  user_hall: string,
  thread_id: string,
): Promise<void> {
  await sql(
    `INSERT INTO nexaas_memory.pa_delivery_marker
       (workspace, drawer_id, user_hall, thread_id, status)
     VALUES ($1, $2, $3, $4, 'queued')
     ON CONFLICT (workspace, drawer_id) DO NOTHING`,
    [workspace, drawer_id, user_hall, thread_id],
  );
}

/**
 * Atomically claim the next pending delivery for a thread. Returns null
 * if no eligible row exists. Concurrent callers for the same thread
 * serialize via SKIP LOCKED; different threads can claim in parallel.
 *
 * Eligible = status in ('queued', 'failed') AND retries < MAX_RETRIES.
 * Rows above MAX_RETRIES are moved to 'dead' by markDeliveryFailed and
 * stop being eligible.
 */
export async function claimNextDelivery(
  workspace: string,
  user_hall: string,
  thread_id: string,
): Promise<DeliveryClaim | null> {
  const row = await sqlOne<{
    drawer_id: string;
    retries: number;
    envelope: string | null;
  }>(
    `WITH claimable AS (
       SELECT workspace, drawer_id
         FROM nexaas_memory.pa_delivery_marker
        WHERE workspace = $1
          AND user_hall = $2
          AND thread_id = $3
          AND status IN ('queued', 'failed')
          AND retries < $4
        ORDER BY claimed_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE nexaas_memory.pa_delivery_marker AS m
        SET status = 'claimed',
            claimed_at = now()
       FROM claimable
      WHERE m.workspace = claimable.workspace
        AND m.drawer_id = claimable.drawer_id
     RETURNING m.drawer_id, m.retries,
               (SELECT content FROM nexaas_memory.events e
                 WHERE e.id = m.drawer_id) AS envelope`,
    [workspace, user_hall, thread_id, MAX_RETRIES],
  );

  if (!row) return null;
  return {
    workspace,
    drawer_id: row.drawer_id,
    user_hall,
    thread_id,
    retries: row.retries,
    envelope: row.envelope ?? "",
  };
}

/**
 * Mark a claimed delivery as successfully sent. Records the upstream
 * channel's message id (Telegram message_id, email Message-Id, etc.)
 * so the delivery can later be referenced for audit / unsend / reply
 * threading.
 */
export async function markDeliverySent(
  claim: DeliveryClaim,
  channel_message_id: string,
): Promise<void> {
  await sql(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET status = 'sent',
            channel_message_id = $3,
            sent_at = now(),
            last_error = NULL
      WHERE workspace = $1 AND drawer_id = $2`,
    [claim.workspace, claim.drawer_id, channel_message_id],
  );
}

/**
 * Mark a claimed delivery as failed. Increments retries. Below the
 * threshold the row goes back to 'failed' for re-pickup; at or above
 * the threshold it goes to terminal 'dead' and an ops_alert row is
 * emitted so an operator can investigate.
 */
export async function markDeliveryFailed(
  claim: DeliveryClaim,
  error: string,
): Promise<void> {
  const nextRetries = claim.retries + 1;
  const terminal = nextRetries >= MAX_RETRIES;

  await sql(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET status = $3,
            retries = $4,
            last_error = $5
      WHERE workspace = $1 AND drawer_id = $2`,
    [
      claim.workspace,
      claim.drawer_id,
      terminal ? "dead" : "failed",
      nextRetries,
      error.slice(0, 1000),
    ],
  );

  if (terminal) {
    await sql(
      `INSERT INTO nexaas_memory.ops_alerts (workspace, event_type, tier, severity, payload)
       VALUES ($1, 'pa_delivery_dead', 'inbox', 'high', $2)`,
      [
        claim.workspace,
        JSON.stringify({
          drawer_id: claim.drawer_id,
          user_hall: claim.user_hall,
          thread_id: claim.thread_id,
          retries: nextRetries,
          last_error: error.slice(0, 1000),
          dead_at: new Date().toISOString(),
        }),
      ],
    );
    await appendWal({
      workspace: claim.workspace,
      op: "pa_delivery_dead",
      actor: "pa-delivery",
      payload: {
        drawer_id: claim.drawer_id,
        user_hall: claim.user_hall,
        thread_id: claim.thread_id,
        retries: nextRetries,
      },
    });
  }
}

/**
 * Reset 'claimed' rows whose lease has expired back to 'failed' so
 * another consumer can pick them up. Returns the number reset.
 * Best-effort — meant to be called periodically by the framework
 * (e.g. once per notification-dispatcher tick).
 */
export async function reapStaleDeliveryClaims(workspace: string): Promise<number> {
  const reset = await sql<{ drawer_id: string }>(
    `UPDATE nexaas_memory.pa_delivery_marker
        SET status = 'failed',
            last_error = COALESCE(last_error, $2)
      WHERE workspace = $1
        AND status = 'claimed'
        AND claimed_at < now() - INTERVAL '${STALE_CLAIM_INTERVAL}'
      RETURNING drawer_id`,
    [workspace, "reaped: claimed delivery exceeded stale threshold"],
  );
  return reset.length;
}
