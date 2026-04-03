/**
 * Batch-dispatched YAML check system for Trigger.dev.
 *
 * Instead of individual schedules per check, a single dispatcher runs at
 * key intervals, collects all due checks, and batch-triggers them.
 * Individual check runs are still visible in the dashboard as separate
 * run-check tasks.
 *
 * Dispatcher:
 *   check-dispatch-frequent   every 15 min   All due checks (daily, weekly, monthly, interval)
 *
 * Queue: "yaml-checks" (concurrency 2) — separate from agent runs
 */

import { schedules, logger, task, tags as tdTags } from "@trigger.dev/sdk/v3";
import { runClaude, type ClaudeResult } from "../lib/claude.js";
import {
  loadCheckById,
  loadActiveChecks,
  getDueChecks,
  buildCheckPrompt,
  type CheckConfig,
} from "../lib/yaml-checks.js";
import { runShell } from "../lib/shell.js";
import { domainForAgent } from "../lib/domain-tags.js";

// ── MCP resolution ──────────────────────────────────────────────────────────
//
// Per-check YAML override for MCP servers. When no override is specified,
// returns empty array — runClaude with empty mcpServers loads no MCP tools,
// which is correct for CLI-based runs that use the workspace's .mcp.json.

function getCheckMcpServers(check: CheckConfig): string[] {
  if (Array.isArray(check.mcp_servers) && check.mcp_servers.length > 0) {
    return check.mcp_servers as string[];
  }
  if (typeof check.mcp_server === "string" && check.mcp_server) {
    return [check.mcp_server as string];
  }
  // No per-check override — runClaude will use no MCP (workspace .mcp.json handles it)
  return [];
}

const CHECK_QUEUE = {
  name: "yaml-checks",
  concurrencyLimit: 2,
} as const;

// ── Core check runner ───────────────────────────────────────────────────────

export const runCheck = task({
  id: "run-check",
  queue: CHECK_QUEUE,
  maxDuration: 600, // 10 min — Claude timeout is 5 min + overhead
  retry: {
    maxAttempts: 2,
    factor: 2,
    minTimeoutInMs: 10_000,
    maxTimeoutInMs: 60_000,
  },
  // Deduplicate by check ID — callers should pass idempotencyKey when triggering
  // to prevent the same check from stacking up across dispatcher ticks
  run: async (check: CheckConfig): Promise<ClaudeResult & { checkId: string }> => {
    // Guard against malformed checks
    if (!check || !check.id || !check.agent) {
      const msg = `Malformed check: ${JSON.stringify(check ?? "undefined").slice(0, 200)}`;
      logger.error(msg);
      throw new Error(msg);
    }

    // Tag with business domain for dashboard filtering
    const domain = domainForAgent(check.agent);
    await tdTags.add([`domain:${domain}`, `agent:${check.agent}`, `check:${check.id}`]);

    const prompt = buildCheckPrompt(check);
    const model = check.model || "sonnet";
    const timeoutMs = 5 * 60 * 1000;

    logger.info(`Dispatching check ${check.id} to agent ${check.agent}`, {
      promptLength: prompt.length,
      model,
      type: check.type,
    });

    // Per-check MCP servers take priority over defaults.
    // YAML checks can specify: mcp_servers: ["server-name"] or mcp_server: "server-name"
    const mcpServers = getCheckMcpServers(check);
    logger.info(`MCP servers for ${check.id}: [${mcpServers.join(", ")}]`);

    const result = await runClaude({
      agent: check.agent,
      prompt,
      model,
      timeoutMs,
      mcpServers,
    });

    if (!result.success) {
      logger.error(`Check ${check.id} failed: ${result.error}`);
      throw new Error(`Check ${check.id} failed: ${result.error}`);
    }

    logger.info(`Check ${check.id} completed`, {
      durationMs: result.durationMs,
      outputLength: result.output?.length ?? 0,
      tokens: result.tokens,
    });

    await updateLastRun(check.id, (check._source_file as string) || undefined);

    return { ...result, checkId: check.id };
  },
});

// ── Batch dispatch helper ───────────────────────────────────────────────────

async function dispatchDueChecks(
  label: string,
  recurrenceFilter?: string
): Promise<{ dispatched: string[]; skipped: number }> {
  // Get current time in configured timezone (default ET)
  const tz = process.env.TRIGGER_TIMEZONE || "America/Toronto";
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: tz })
  );

  const due = getDueChecks(now, recurrenceFilter);

  if (due.length === 0) {
    logger.info(`${label}: no checks due`);
    return { dispatched: [], skipped: 0 };
  }

  // Filter out any malformed checks before dispatch
  const validChecks = due.filter((c) => c && c.id && c.agent && c.recurrence);
  if (validChecks.length < due.length) {
    logger.warn(`${label}: filtered out ${due.length - validChecks.length} malformed checks`, {
      originalCount: due.length,
      validCount: validChecks.length,
    });
  }

  if (validChecks.length === 0) {
    logger.info(`${label}: no valid checks to dispatch`);
    return { dispatched: [], skipped: due.length };
  }

  logger.info(`${label}: ${validChecks.length} checks due`, {
    checks: validChecks.map((c) => c.id),
  });

  // Double-check: filter out any falsy values before passing to batchTrigger
  const safeChecks = validChecks.filter(c => !!c);
  if (safeChecks.length < validChecks.length) {
    logger.error(`${label}: falsy check(s) found after filter, removing before batch trigger`, {
      count: validChecks.length - safeChecks.length,
    });
  }

  // Batch trigger all valid checks — batchTrigger expects { payload: T }[] not T[]
  const batchResult = await runCheck.batchTrigger(
    safeChecks.map((check) => ({ payload: check }))
  );

  const dispatched = safeChecks.map((c) => c.id);
  logger.info(`${label}: batch-triggered ${dispatched.length} checks`, {
    batchId: batchResult.batchId,
    runs: (batchResult as any).runs?.length ?? dispatched.length,
  });

  return { dispatched, skipped: due.length - safeChecks.length };
}

// ── Dispatchers ─────────────────────────────────────────────────────────────
//
// All dispatchers fire at */15 to match the 15-min bucket system in getDueChecks().
// Each check's recurrence_minute is bucketed into :00-14, :15-29, :30-44, :45-59.
// The dispatcher at :30 picks up all checks with targetMin 30-44.

// Universal dispatcher — fires every 15 min and dispatches ALL due checks.
// getDueChecks() handles the bucketing logic: each check's recurrence_minute
// is bucketed into :00-14, :15-29, :30-44, :45-59 matching the */15 ticks.
export const dispatchFrequent = schedules.task({
  id: "check-dispatch-frequent",
  cron: {
    pattern: "1,16,31,46 * * * *",
    timezone: process.env.TRIGGER_TIMEZONE || "America/Toronto",
  },
  maxDuration: 120, // 2 min — fire-and-forget dispatch only
  run: async () => {
    // No recurrence filter — dispatches ALL types (daily, weekly, monthly, interval)
    return await dispatchDueChecks("universal");
  },
});

// ── Legacy support: scheduled-check for any remaining individual schedules ──

export const scheduledCheck = schedules.task({
  id: "scheduled-check",
  maxDuration: 600, // 10 min — triggerAndWait on single check
  run: async (payload) => {
    const checkId = payload.externalId;
    if (!checkId) {
      logger.error("scheduled-check triggered without externalId");
      return { success: false, error: "missing externalId" };
    }

    const check = loadCheckById(checkId);
    if (!check) {
      logger.error(`Check not found: ${checkId}`);
      return { success: false, error: `check not found: ${checkId}` };
    }

    if (check.status !== "active") {
      return { success: true, skipped: true, reason: check.status };
    }

    const result = await runCheck.triggerAndWait(check);
    return result;
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function updateLastRun(
  checkId: string,
  sourceFile?: string
): Promise<void> {
  if (!sourceFile) return;

  const checksDir = process.env.CHECKS_DIR || "operations/memory/checks";

  try {
    await runShell({
      command: `python3 -c "
import yaml, sys
from datetime import datetime, timezone

path = '${checksDir}/${sourceFile}'
with open(path) as f:
    data = yaml.safe_load(f)

for check in data.get('checks', []):
    if check.get('id') == '${checkId}':
        check['last_run'] = datetime.now(timezone.utc).isoformat()
        break

with open(path, 'w') as f:
    yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
"`,
      timeoutMs: 10_000,
    });
  } catch (err) {
    logger.warn(`Failed to update last_run for ${checkId}: ${err}`);
  }
}
