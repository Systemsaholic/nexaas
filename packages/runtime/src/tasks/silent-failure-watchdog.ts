/**
 * Silent-failure watchdog (#69).
 *
 * Catches the class of failure where a single skill dies on every run and
 * nobody notices — the failures sit in skill_runs with status='failed' and
 * no alert escalates. Hooked into run-tracker.markStepFailed: each time a
 * run fails, count consecutive prior failures for the same (workspace,
 * skill_id). When the streak hits the threshold exactly, emit a drawer into
 * notifications.pending.ops-alerts.silent-failure for the
 * notification-dispatcher to deliver.
 *
 * De-dupe: alert fires exactly once per streak. If the (threshold+1)th prior
 * run is also failed, this is not a fresh threshold crossing — we already
 * alerted and skip. A subsequent `completed` run resets the streak; a new
 * threshold crossing can alert again.
 *
 * Configuration (all env-var, no manifest dependency):
 *   NEXAAS_SILENT_FAILURE_THRESHOLD        default 5; minimum 2
 *   NEXAAS_SILENT_FAILURE_CHANNEL_ROLE     no default — unset = disabled
 *
 * The watchdog is a no-op when the channel role isn't set, so existing
 * adopters see no behavior change until they opt in.
 */

import { sql, palace, appendWal } from "@nexaas/palace";

const THRESHOLD = (() => {
  const raw = process.env.NEXAAS_SILENT_FAILURE_THRESHOLD;
  if (!raw) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 2) return 5;
  return parsed;
})();

const CHANNEL_ROLE = process.env.NEXAAS_SILENT_FAILURE_CHANNEL_ROLE;

type RecentRun = {
  status: string;
  error_summary: string | null;
  started_at: string;
};

export async function checkFailureStreak(
  workspace: string,
  skillId: string,
): Promise<void> {
  if (!CHANNEL_ROLE) return;

  // Pull THRESHOLD+1 most recent terminal runs. We need one extra row to
  // tell a *fresh* threshold crossing (streak exactly == THRESHOLD) from an
  // already-alerted ongoing streak (streak > THRESHOLD). 'running' and
  // 'waiting' are skipped — those aren't terminal outcomes yet. 'skipped'
  // is also ignored since it represents a deliberate no-op, not a failure.
  const recent = await sql<RecentRun>(
    `SELECT status, error_summary, started_at::text AS started_at
     FROM nexaas_memory.skill_runs
     WHERE workspace = $1 AND skill_id = $2
       AND status IN ('completed', 'failed', 'escalated', 'cancelled')
     ORDER BY started_at DESC
     LIMIT $3`,
    [workspace, skillId, THRESHOLD + 1],
  );

  if (recent.length < THRESHOLD) return;
  if (!recent.slice(0, THRESHOLD).every(r => r.status === "failed")) return;
  // Already alerted — the streak has been longer than THRESHOLD for a while.
  if (recent.length > THRESHOLD && recent[THRESHOLD].status === "failed") return;

  const firstFailedAt = recent[THRESHOLD - 1].started_at;
  const lastError = recent[0].error_summary ?? "(no error summary)";

  const session = palace.enter({ workspace });
  await session.writeDrawer(
    { wing: "notifications", hall: "pending", room: "ops-alerts.silent-failure" },
    JSON.stringify({
      idempotency_key: `silent-failure:${skillId}:${firstFailedAt}`,
      channel_role: CHANNEL_ROLE,
      content:
        `⚠️ Silent failure: skill ${skillId} has failed ${THRESHOLD} runs in a row.\n` +
        `First failure in streak: ${firstFailedAt}\n` +
        `Last error: ${lastError.slice(0, 400)}`,
    }),
  );

  await appendWal({
    workspace,
    op: "silent_failure_alerted",
    actor: "silent-failure-watchdog",
    payload: {
      skill_id: skillId,
      streak: THRESHOLD,
      first_failed_at: firstFailedAt,
      channel_role: CHANNEL_ROLE,
      last_error: lastError.slice(0, 500),
    },
  });
}
