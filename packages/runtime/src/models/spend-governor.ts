/**
 * Spend governor — per-workspace daily AI budget (#215).
 *
 * Recording: `recordSpend()` is called from the two model chokepoints
 * (agentic loop, model gateway) after each completed call/run, upserting
 * into nexaas_memory.spend_daily keyed by workspace-local day.
 *
 * Enforcement is deliberately *not* in the per-turn hot path. The spec'd
 * behavior (#215) is "in-flight runs finish their current step and park":
 *   - ai-skill checks the budget pre-run (before MCP/model cost) and skips
 *     cleanly — no failure noise, no silent-failure counter pollution
 *   - the gateway checks pre-call and throws SpendBudgetExceededError,
 *     which the fallback chain must never catch (a budget breach surfacing
 *     as a provider error would route around the cap and keep spending on
 *     the fallback key)
 *   - the worker's spend-budget-monitor task pauses/resumes the workspace
 *     queue persistently (survives worker restarts, unlike the in-memory
 *     429 backoff timers in bullmq/rate-limit.ts)
 *
 * Overshoot is bounded by per-run caps (#25): at most
 * worker-concurrency × max_spend_usd beyond the budget.
 *
 * Override: workspace_kv key `spend_budget_override_date` set to the
 * workspace-local day (YYYY-MM-DD) disables enforcement for that day only —
 * the operator's "yes, I mean it, keep running today" escape hatch.
 */

import { sql, sqlOne } from "@nexaas/palace";

export class SpendBudgetExceededError extends Error {
  readonly code = "spend_budget_exceeded";
  constructor(
    readonly workspace: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Daily AI spend budget exceeded for workspace '${workspace}': ` +
        `$${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)} budget. ` +
        `Resumes at local midnight, or set workspace_kv 'spend_budget_override_date' to today.`,
    );
    this.name = "SpendBudgetExceededError";
  }
}

export interface BudgetState {
  day: string;
  budgetUsd: number | null;
  spentUsd: number;
  modelCalls: number;
  overridden: boolean;
  exceeded: boolean;
}

// Timezone changes are rare; a short cache keeps the per-run/-call DB
// overhead at one query (the spend row) instead of three.
const TZ_CACHE_MS = 5 * 60_000;
const _tzCache = new Map<string, { tz: string; at: number }>();

async function workspaceTimezone(workspace: string): Promise<string> {
  const cached = _tzCache.get(workspace);
  if (cached && Date.now() - cached.at < TZ_CACHE_MS) return cached.tz;
  let tz = "UTC";
  try {
    const row = await sqlOne<{ timezone: string }>(
      `SELECT timezone FROM nexaas_memory.workspace_config WHERE workspace = $1`,
      [workspace],
    );
    if (row?.timezone) tz = row.timezone;
  } catch {
    /* unconfigured workspace — UTC */
  }
  _tzCache.set(workspace, { tz, at: Date.now() });
  return tz;
}

/** YYYY-MM-DD in the given IANA timezone (en-CA locale formats exactly that). */
export function localDay(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Record completed model spend. Never throws — a spend-accounting failure
 * must not fail the run that already happened.
 */
export async function recordSpend(
  workspace: string,
  usd: number,
  modelCalls = 1,
): Promise<void> {
  if (!(usd > 0) && modelCalls <= 0) return;
  try {
    const day = localDay(await workspaceTimezone(workspace));
    await sql(
      `INSERT INTO nexaas_memory.spend_daily (workspace, day, usd, model_calls)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace, day)
         DO UPDATE SET usd = nexaas_memory.spend_daily.usd + EXCLUDED.usd,
                       model_calls = nexaas_memory.spend_daily.model_calls + EXCLUDED.model_calls,
                       updated_at = now()`,
      [workspace, day, usd, modelCalls],
    );
  } catch (err) {
    console.error(`[nexaas] spend-governor: failed to record spend for ${workspace}:`, err);
  }
}

export async function getBudgetState(workspace: string): Promise<BudgetState> {
  const tz = await workspaceTimezone(workspace);
  const day = localDay(tz);

  const cfg = await sqlOne<{ spend_daily_budget_usd: string | null }>(
    `SELECT spend_daily_budget_usd FROM nexaas_memory.workspace_config WHERE workspace = $1`,
    [workspace],
  );
  const budgetRaw = cfg?.spend_daily_budget_usd;
  const budgetUsd = budgetRaw == null ? null : Number(budgetRaw);

  const spent = await sqlOne<{ usd: string; model_calls: number }>(
    `SELECT usd, model_calls FROM nexaas_memory.spend_daily WHERE workspace = $1 AND day = $2`,
    [workspace, day],
  );
  const spentUsd = spent ? Number(spent.usd) : 0;
  const modelCalls = spent ? Number(spent.model_calls) : 0;

  let overridden = false;
  try {
    const kv = await sqlOne<{ value: string }>(
      `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'spend_budget_override_date'`,
      [workspace],
    );
    overridden = kv?.value === day;
  } catch {
    /* kv table absent on very old schemas — no override */
  }

  const exceeded =
    budgetUsd != null && Number.isFinite(budgetUsd) && !overridden && spentUsd >= budgetUsd;

  return { day, budgetUsd, spentUsd, modelCalls, overridden, exceeded };
}

/**
 * Throw SpendBudgetExceededError when the workspace is over its daily
 * budget. Callers in the model path invoke this BEFORE any provider call —
 * the error class is the contract that lets the gateway distinguish
 * "budget" from "provider failed" and skip the fallback chain.
 */
export async function assertWithinBudget(workspace: string): Promise<BudgetState> {
  const state = await getBudgetState(workspace);
  if (state.exceeded) {
    throw new SpendBudgetExceededError(workspace, state.spentUsd, state.budgetUsd as number);
  }
  return state;
}
