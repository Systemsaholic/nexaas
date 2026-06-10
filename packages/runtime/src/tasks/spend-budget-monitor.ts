/**
 * Spend-budget monitor — pause/resume the workspace queue on daily budget
 * breach (#215).
 *
 * Runs every minute as a worker background task. Monitor-driven rather than
 * timer-driven on purpose: the 429 backoff (#27, bullmq/rate-limit.ts) uses
 * in-memory setTimeout resumes, which is fine for 5-minute cooldowns but
 * wrong for an overnight budget pause — BullMQ pause state persists in
 * Redis across worker restarts, the timer doesn't, and the queue would
 * stay paused forever. This monitor re-evaluates the budget on every tick:
 *
 *   over budget  + no pause marker → pause queue, alert ops, WAL
 *   under budget + pause marker    → resume queue, WAL
 *                                    (day rollover and the operator's
 *                                     override both land here naturally)
 *
 * The pause marker lives in workspace_kv (`spend_pause_active_day`), so a
 * restarted worker resumes a stale pause and never resumes a queue some
 * other subsystem paused.
 */

import { appendWal, sql, sqlOne } from "@nexaas/palace";
import { getSkillQueue } from "../bullmq/queues.js";
import { getBudgetState, type BudgetState } from "../models/spend-governor.js";
import { notify } from "../notifications.js";
import { pushFleetEvent } from "../fleet/heartbeat.js";

const MARKER_KEY = "spend_pause_active_day";

async function readMarker(workspace: string): Promise<string | null> {
  const row = await sqlOne<{ value: string }>(
    `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = $2`,
    [workspace, MARKER_KEY],
  );
  return row?.value ?? null;
}

async function writeMarker(workspace: string, day: string): Promise<void> {
  await sql(
    `INSERT INTO nexaas_memory.workspace_kv (workspace, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value`,
    [workspace, MARKER_KEY, day],
  );
}

async function clearMarker(workspace: string): Promise<void> {
  await sql(
    `DELETE FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = $2`,
    [workspace, MARKER_KEY],
  );
}

/**
 * Pause the workspace queue for a budget breach. Idempotent per local day.
 * Also callable directly from ai-skill's pre-run gate so the pause lands
 * immediately instead of waiting for the next monitor tick.
 */
export async function pauseForBudgetBreach(
  workspace: string,
  state: BudgetState,
): Promise<void> {
  const marker = await readMarker(workspace);
  if (marker === state.day) return; // already paused for today

  const queue = getSkillQueue(workspace);
  try {
    await queue.pause();
  } catch (err) {
    console.error(`[nexaas] spend-budget: failed to pause queue ${workspace}:`, err);
    return;
  }
  await writeMarker(workspace, state.day);
  await appendWal({
    workspace,
    op: "spend_budget_exceeded",
    actor: "spend-budget-monitor",
    payload: {
      day: state.day,
      spent_usd: state.spentUsd,
      budget_usd: state.budgetUsd,
      model_calls: state.modelCalls,
      resumes: "local midnight (or workspace_kv spend_budget_override_date = today)",
    },
  });
  console.warn(
    `[nexaas] spend-budget: workspace ${workspace} paused — $${state.spentUsd.toFixed(4)} spent of $${state.budgetUsd?.toFixed(2)} daily budget`,
  );
  try {
    await notify({
      workspace,
      severity: "critical",
      component: "spend-budget",
      title: `Daily AI budget exceeded — queue paused`,
      body:
        `Workspace '${workspace}' spent $${state.spentUsd.toFixed(2)} of its $${state.budgetUsd?.toFixed(2)} daily budget ` +
        `(${state.modelCalls} model calls). Skill queue is paused until local midnight. ` +
        `To resume today: nexaas config set spend-override today`,
      dedupeKey: `spend-budget-${workspace}-${state.day}`,
      dedupeWindowMinutes: 24 * 60,
    });
  } catch (err) {
    console.error(`[nexaas] spend-budget: alert dispatch failed:`, err);
  }

  // Fleet escalation (#216): a budget breach burns the operator's margin —
  // page severity. Silent no-op without a fleet endpoint. The dedupe key
  // matches the local alert's (one event per workspace-day).
  await pushFleetEvent(workspace, {
    type: "spend_budget_exceeded",
    severity: "page",
    title: `Daily AI budget exceeded — queue paused`,
    body:
      `$${state.spentUsd.toFixed(2)} spent of $${state.budgetUsd?.toFixed(2)} daily budget ` +
      `(${state.modelCalls} model calls). Queue paused until local midnight or operator override.`,
    dedupe_key: `spend-budget-${workspace}-${state.day}`,
    data: {
      day: state.day,
      spent_usd: state.spentUsd,
      budget_usd: state.budgetUsd,
      model_calls: state.modelCalls,
    },
  });
}

async function resumeAfterBudgetPause(workspace: string, state: BudgetState): Promise<void> {
  const queue = getSkillQueue(workspace);
  try {
    await queue.resume();
  } catch (err) {
    console.error(`[nexaas] spend-budget: failed to resume queue ${workspace}:`, err);
    return;
  }
  await clearMarker(workspace);
  await appendWal({
    workspace,
    op: "spend_budget_resumed",
    actor: "spend-budget-monitor",
    payload: {
      day: state.day,
      reason: state.overridden ? "operator_override" : "day_rollover_or_budget_change",
    },
  });
  console.log(`[nexaas] spend-budget: workspace ${workspace} queue resumed`);
}

/** One monitor tick. Exported for the worker's background-task loop. */
export async function spendBudgetTick(workspace: string): Promise<void> {
  try {
    const state = await getBudgetState(workspace);
    if (state.exceeded) {
      await pauseForBudgetBreach(workspace, state);
    } else {
      const marker = await readMarker(workspace);
      if (marker) await resumeAfterBudgetPause(workspace, state);
    }
  } catch (err) {
    console.error(`[nexaas] spend-budget monitor tick failed:`, err);
  }
}
