/**
 * Scheduler watchdog (#86 Gap 2).
 *
 * Detects cron triggers that should have fired but didn't — the failure
 * mode that lost `marketing-health-pipeline` for ~2 weeks on Phoenix
 * after the 2026-04-30 worker SIGTERM. The job vanished from BullMQ's
 * delayed set and never appeared in `completed` / `failed` / `stalled`,
 * so silent-failure-watchdog (#69) had nothing to count. Without this
 * watchdog, the only way to find a missed firing is to manually
 * `ZRANGE` BullMQ's keys.
 *
 * How it works:
 *
 * 1. Every N minutes, read every job scheduler in the workspace's
 *    BullMQ queue.
 * 2. For each scheduler, compare its `next` (millis-since-epoch) against
 *    `now`. If `now - next` exceeds `2 * period` (where `period` is
 *    inferred from the cron pattern), the cron is overdue.
 * 3. Emit one drawer per overdue cron to
 *    `notifications.pending.ops-alerts.scheduler-overdue`. The
 *    notification-dispatcher routes via the configured channel role;
 *    no separate transport.
 *
 * De-dupe: idempotency_key is `scheduler-overdue:<workspace>:<skillId>:<scheduledFor>`,
 * so the same missed firing alerts exactly once across watchdog ticks.
 * A subsequent missed firing for the same skill at a different time
 * gets its own alert.
 *
 * Configuration (env-var, no manifest dependency):
 *   NEXAAS_SCHEDULER_WATCHDOG_INTERVAL_MS  default 300000 (5 min); minimum 60000
 *   NEXAAS_SCHEDULER_WATCHDOG_CHANNEL_ROLE no default — unset = disabled
 *   NEXAAS_SCHEDULER_WATCHDOG_GRACE_MULT   default 2 (× period); use 1 for tighter
 *
 * Disabled-by-default for compatibility with existing adopters; opt-in
 * by setting CHANNEL_ROLE.
 */

import { Queue } from "bullmq";
import parser from "cron-parser";
import { palace, appendWal } from "@nexaas/palace";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_GRACE_MULT = 2;

const CHANNEL_ROLE = process.env.NEXAAS_SCHEDULER_WATCHDOG_CHANNEL_ROLE;
const GRACE_MULT = (() => {
  const raw = process.env.NEXAAS_SCHEDULER_WATCHDOG_GRACE_MULT;
  if (!raw) return DEFAULT_GRACE_MULT;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_GRACE_MULT;
  return parsed;
})();

let _interval: NodeJS.Timeout | null = null;
let _polling = false;

export interface OverdueCron {
  skillId: string;
  pattern: string;
  tz: string;
  scheduledForMs: number;
  scheduledForIso: string;
  lateByMs: number;
  periodMs: number;
}

/**
 * Compute approximate period of a cron pattern by taking the delta between
 * the next two fires. Returns 0 for unparseable patterns; callers treat 0
 * as "skip" so a malformed pattern doesn't fire false alerts.
 */
function inferPeriodMs(pattern: string, tz: string): number {
  try {
    const it = parser.parseExpression(pattern, { tz, currentDate: new Date() });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    return Math.max(0, b - a);
  } catch {
    return 0;
  }
}

/**
 * Inspect every job scheduler on the queue, return overdue ones.
 *
 * Exported for the regression test (#86 Gap 2 test); not part of the
 * runtime's public surface — the periodic loop in `startSchedulerWatchdog`
 * is what skill authors and operators see.
 */
export async function findOverdueCrons(
  queue: Queue,
  graceMult: number = GRACE_MULT,
  now: number = Date.now(),
): Promise<OverdueCron[]> {
  let schedulers: Array<{
    name?: string;
    pattern?: string;
    tz?: string;
    next?: number | null;
    template?: { data?: unknown };
  }>;
  try {
    schedulers = await queue.getJobSchedulers();
  } catch {
    return [];
  }

  const overdue: OverdueCron[] = [];
  for (const sched of schedulers) {
    if (!sched.pattern || !sched.name) continue;
    const data = sched.template?.data as { skillId?: string } | undefined;
    if (!data?.skillId) continue;

    const tz = sched.tz ?? "UTC";
    const period = inferPeriodMs(sched.pattern, tz);
    if (period === 0) continue;

    // Missing `next` is itself a signal — BullMQ should always have one
    // for a scheduler that's still active. Treat as overdue at expected
    // next-fire age (1 period beyond the previous fire).
    const next = sched.next ?? null;
    if (next === null) {
      overdue.push({
        skillId: data.skillId,
        pattern: sched.pattern,
        tz,
        scheduledForMs: now - period,
        scheduledForIso: new Date(now - period).toISOString(),
        lateByMs: period,
        periodMs: period,
      });
      continue;
    }

    const lateBy = now - next;
    if (lateBy > graceMult * period) {
      overdue.push({
        skillId: data.skillId,
        pattern: sched.pattern,
        tz,
        scheduledForMs: next,
        scheduledForIso: new Date(next).toISOString(),
        lateByMs: lateBy,
        periodMs: period,
      });
    }
  }

  return overdue;
}

/**
 * Emit one drawer per overdue cron, keyed for once-per-missed-firing
 * de-dupe. Returns the count actually emitted (caller can WAL it).
 */
async function emitOverdueAlerts(
  workspace: string,
  overdue: OverdueCron[],
): Promise<number> {
  if (!CHANNEL_ROLE || overdue.length === 0) return 0;

  const session = palace.enter({ workspace });
  let emitted = 0;
  for (const o of overdue) {
    const lateMin = Math.round(o.lateByMs / 60000);
    const periodMin = Math.round(o.periodMs / 60000);
    try {
      await session.writeDrawer(
        { wing: "notifications", hall: "pending", room: "ops-alerts.scheduler-overdue" },
        JSON.stringify({
          idempotency_key: `scheduler-overdue:${workspace}:${o.skillId}:${o.scheduledForIso}`,
          channel_role: CHANNEL_ROLE,
          content:
            `⚠️ Cron overdue: ${o.skillId}\n` +
            `Pattern: ${o.pattern} (${o.tz})\n` +
            `Expected fire: ${o.scheduledForIso}\n` +
            `Late by: ${lateMin} min (period ${periodMin} min)`,
        }),
      );
      emitted++;
    } catch (err) {
      console.error(
        `[nexaas] scheduler-watchdog: emit failed for ${o.skillId} @ ${o.scheduledForIso}:`,
        err,
      );
    }
  }
  return emitted;
}

export async function checkSchedulerHealth(
  workspace: string,
  queue: Queue,
): Promise<{ overdue: number; alerted: number }> {
  const overdue = await findOverdueCrons(queue);
  if (overdue.length === 0) return { overdue: 0, alerted: 0 };

  const alerted = await emitOverdueAlerts(workspace, overdue);

  await appendWal({
    workspace,
    op: "scheduler_watchdog_overdue",
    actor: "scheduler-watchdog",
    payload: {
      overdue_count: overdue.length,
      alerted_count: alerted,
      sample: overdue.slice(0, 5).map((o) => ({
        skill_id: o.skillId,
        pattern: o.pattern,
        late_min: Math.round(o.lateByMs / 60000),
      })),
    },
  });

  return { overdue: overdue.length, alerted };
}

export function startSchedulerWatchdog(
  workspace: string,
  queue: Queue,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;
  if (!CHANNEL_ROLE) {
    console.log(
      `[nexaas] scheduler-watchdog: NEXAAS_SCHEDULER_WATCHDOG_CHANNEL_ROLE unset; disabled`,
    );
    return;
  }

  const raw = opts.intervalMs ?? Number.parseInt(
    process.env.NEXAAS_SCHEDULER_WATCHDOG_INTERVAL_MS ?? `${DEFAULT_INTERVAL_MS}`,
    10,
  );
  const interval = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? raw : DEFAULT_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      const result = await checkSchedulerHealth(workspace, queue);
      if (result.overdue > 0) {
        console.log(
          `[nexaas] Scheduler watchdog: ${result.overdue} overdue cron(s), ${result.alerted} alert(s) emitted`,
        );
      }
    } catch (err) {
      console.error("[nexaas] scheduler-watchdog tick error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Scheduler watchdog started (every ${Math.round(interval / 1000)}s, channel=${CHANNEL_ROLE})`);
}

export function stopSchedulerWatchdog(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
