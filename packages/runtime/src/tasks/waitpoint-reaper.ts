/**
 * Waitpoint timeout reaper — fires timeout policies for expired waitpoints.
 *
 * Runs every 60 seconds. For each expired waitpoint:
 * - escalate (default): write escalation drawer, notify ops
 * - auto_approve: resolve as approved
 * - auto_reject: resolve as rejected
 * - auto_cancel: cancel the run
 *
 * Expiry is a TERMINAL, single-fire transition (#231). Every waitpoint the
 * reaper processes is stamped `timeout_handled_at` and excluded from
 * subsequent ticks. Before the fix, the `escalate` policy (the default)
 * left dormant_signal/dormant_until intact, so an expired waitpoint nothing
 * consumed re-escalated every tick forever — Phoenix logged ~35k severity-
 * high ops_alerts per 12h off ~295 abandoned approvals. `escalate`
 * deliberately keeps dormant_signal set (so resolveWaitpoint can still
 * approve it later); `timeout_handled_at` is what stops the re-alert.
 */

import { sql, appendWal, resolveWaitpoint } from "@nexaas/palace";
import { runTracker } from "../run-tracker.js";

interface ExpiredWaitpoint {
  id: string;
  workspace: string;
  skill_id: string;
  run_id: string;
  step_id: string;
  dormant_signal: string;
  dormant_until: Date;
  metadata: Record<string, unknown>;
  reminder_at: Date | null;
  reminder_sent: boolean;
}

export async function reapExpiredWaitpoints(): Promise<number> {
  // Find waitpoints that have passed their timeout and not yet been handled
  // (#231). `timeout_handled_at IS NULL` is the single-fire guard — without
  // it the escalate policy re-alerted every tick.
  const expired = await sql<ExpiredWaitpoint>(`
    SELECT id, workspace, skill_id, run_id, step_id, dormant_signal,
           dormant_until, metadata, reminder_at, reminder_sent
    FROM nexaas_memory.events
    WHERE dormant_signal IS NOT NULL
      AND dormant_until IS NOT NULL
      AND dormant_until < now()
      AND timeout_handled_at IS NULL
    LIMIT 50
  `);

  let reaped = 0;

  for (const wp of expired) {
    const notify = wp.metadata?.notify as Record<string, unknown> | undefined;
    const onTimeout = (notify?.on_timeout as string) ?? "escalate";

    try {
      switch (onTimeout) {
        case "auto_approve":
          await resolveWaitpoint(
            wp.dormant_signal,
            { decision: "approved", source: "timeout_auto_approve", authorized: false },
            "system:timeout-reaper",
            wp.workspace,
          );
          break;

        case "auto_reject":
          await resolveWaitpoint(
            wp.dormant_signal,
            { decision: "rejected", source: "timeout_auto_reject", authorized: false },
            "system:timeout-reaper",
            wp.workspace,
          );
          break;

        case "auto_cancel": {
          // Claim guard (#261): only cancel if the waitpoint is still open.
          // Without `dormant_signal IS NOT NULL ... RETURNING`, a human
          // approval landing a moment earlier still got its freshly-resumed
          // run marked cancelled by this path.
          const claimed = await sql<{ id: string }>(
            `UPDATE nexaas_memory.events SET dormant_signal = NULL
              WHERE id = $1 AND dormant_signal IS NOT NULL
              RETURNING id`,
            [wp.id],
          );
          if (claimed.length === 0) break;
          if (wp.run_id) await runTracker.markCancelled(wp.run_id);
          await appendWal({
            workspace: wp.workspace,
            op: "waitpoint_timeout_cancelled",
            actor: "system:timeout-reaper",
            payload: { signal: wp.dormant_signal, run_id: wp.run_id, skill_id: wp.skill_id },
          });
          break;
        }

        case "escalate":
        default:
          // Write escalation drawer
          await sql(`
            INSERT INTO nexaas_memory.ops_alerts (workspace, event_type, tier, severity, payload)
            VALUES ($1, 'waitpoint_timeout', 'inbox', 'high', $2)
          `, [
            wp.workspace,
            JSON.stringify({
              signal: wp.dormant_signal,
              run_id: wp.run_id,
              skill_id: wp.skill_id,
              timed_out_at: new Date().toISOString(),
              dormant_until: wp.dormant_until,
            }),
          ]);

          await appendWal({
            workspace: wp.workspace,
            op: "waitpoint_timeout_escalated",
            actor: "system:timeout-reaper",
            payload: { signal: wp.dormant_signal, run_id: wp.run_id, skill_id: wp.skill_id },
          });
          break;
      }

      // Terminal, single-fire (#231): mark handled so this waitpoint is
      // never re-processed, regardless of policy. auto_* already cleared
      // dormant_signal; escalate keeps it resolvable and relies on this
      // stamp. Set last, so a throw before this point leaves it for retry
      // on the next tick rather than silently swallowing an unhandled
      // expiry.
      await sql(
        `UPDATE nexaas_memory.events SET timeout_handled_at = now() WHERE id = $1`,
        [wp.id],
      );

      reaped++;
    } catch (err) {
      console.error(`[reaper] Failed to process waitpoint ${wp.dormant_signal}:`, err);
    }
  }

  return reaped;
}

export async function sendPendingReminders(): Promise<number> {
  // Find waitpoints with pending reminders
  const pending = await sql<{ id: string; dormant_signal: string; workspace: string; metadata: Record<string, unknown> }>(`
    SELECT id, dormant_signal, workspace, metadata
    FROM nexaas_memory.events
    WHERE dormant_signal IS NOT NULL
      AND reminder_at IS NOT NULL
      AND reminder_at < now()
      AND reminder_sent = false
    LIMIT 50
  `);

  let sent = 0;

  for (const wp of pending) {
    await sql(`UPDATE nexaas_memory.events SET reminder_sent = true WHERE id = $1`, [wp.id]);

    await appendWal({
      workspace: wp.workspace,
      op: "waitpoint_reminder_sent",
      actor: "system:timeout-reaper",
      payload: { signal: wp.dormant_signal },
    });

    sent++;
  }

  return sent;
}
