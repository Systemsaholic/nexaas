/**
 * Nexaas Health Monitor — self-monitoring skill that watches the framework.
 *
 * Runs every 5 minutes, checks all critical systems, detects anomalies,
 * and alerts via Telegram when something needs attention.
 *
 * Checks:
 * 1. Worker health (BullMQ responding)
 * 2. Skill success rates (detect failure spikes)
 * 3. Consecutive failures per skill (3+ = alert)
 * 4. Stale skills (hasn't run when it should have)
 * 5. API credit status (Anthropic key validity)
 * 6. Palace health (DB connectivity, table count)
 * 7. Redis health
 * 8. Cost accumulation (daily spend tracking)
 * 9. WAL chain integrity (quick check)
 * 10. Disk and memory usage
 */

import { sql, appendWal, writeDrawerRaw } from "@nexaas/palace";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { notify } from "../notifications.js";
import { probeModel } from "../models/probe.js";

// Async exec — health monitor runs every 5 min inside the worker. Using
// execSync here (as before) blocked the event loop for each shell check,
// stalling /health, BullMQ scheduler ticks, and any HTTP consumer for
// hundreds of ms at a stretch. Same root cause as #33.
const execAsync = promisify(execCb);

async function exec(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf-8", timeout: 10_000 });
    return stdout.trim();
  } catch { return ""; }
}

export interface HealthAlert {
  severity: "critical" | "warning" | "info";
  component: string;
  message: string;
}

export interface HealthReport {
  timestamp: string;
  workspace: string;
  status: "healthy" | "degraded" | "critical";
  alerts: HealthAlert[];
  metrics: {
    worker_uptime_seconds: number;
    skills_total: number;
    skills_healthy: number;
    skills_failing: number;
    completions_last_hour: number;
    failures_last_hour: number;
    success_rate_last_hour: number;
    api_cost_today_usd: number;
    /** Daily spend budget (#215). null = no budget configured / pre-026 schema. */
    spend_budget: { budget_usd: number; spent_usd: number; paused: boolean } | null;
    wal_entries_total: number;
    palace_drawers: number;
    memory_used_gb: number;
    memory_available_gb: number;
    disk_used_pct: number;
  };
}

export interface HealthCheckOpts {
  /**
   * Probe the worker's HTTP /health endpoint instead of trusting
   * process.uptime(). Out-of-process callers (`nexaas health`) set this;
   * the in-process monitor must NOT — a self-request from inside the
   * worker's own event loop is the #33 deadlock class.
   */
  probeWorker?: boolean;
}

/**
 * THE health check (#256). One set of checks shared by the in-process
 * 5-minute monitor and `nexaas health` — before the fold, the CLI carried
 * its own diverging copy (#245's cadence-aware staleness only landed in
 * the monitor; #215's spend budget only in the CLI).
 */
export async function runHealthCheck(workspace: string, opts: HealthCheckOpts = {}): Promise<HealthReport> {
  const alerts: HealthAlert[] = [];
  const now = new Date().toISOString();

  // 1. Worker health — in-process, use process.uptime() directly (see
  // HealthCheckOpts.probeWorker); out-of-process, ask the worker itself.
  let workerUptime = process.uptime();
  if (opts.probeWorker) {
    const port = process.env.NEXAAS_WORKER_PORT ?? "9090";
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      const h = (await res.json()) as { status?: string; uptime?: number };
      workerUptime = h.uptime ?? 0;
      if (h.status !== "healthy") {
        alerts.push({ severity: "critical", component: "worker", message: "Worker reports unhealthy" });
      }
    } catch {
      workerUptime = 0;
      alerts.push({ severity: "critical", component: "worker", message: `Worker not responding on :${port}` });
    }
  }

  // 2. Skill success rates (last hour)
  const hourlyStats = await sql<{ completed: string; failed: string }>(`
    SELECT
      count(*) FILTER (WHERE status = 'completed') as completed,
      count(*) FILTER (WHERE status = 'failed') as failed
    FROM nexaas_memory.skill_runs
    WHERE started_at > now() - interval '1 hour'
      AND status IN ('completed', 'failed')
  `);

  const completionsLastHour = parseInt(hourlyStats[0]?.completed ?? "0", 10);
  const failuresLastHour = parseInt(hourlyStats[0]?.failed ?? "0", 10);
  const totalLastHour = completionsLastHour + failuresLastHour;
  const successRate = totalLastHour > 0 ? Math.round((completionsLastHour / totalLastHour) * 100) : 100;

  if (successRate < 80 && totalLastHour > 5) {
    alerts.push({
      severity: "warning",
      component: "skills",
      message: `Success rate dropped to ${successRate}% in the last hour (${failuresLastHour} failures / ${totalLastHour} total)`,
    });
  }

  // 3. Consecutive failures per skill
  const consecutiveFailures = await sql<{ skill_id: string; consecutive: string }>(`
    WITH ranked AS (
      SELECT skill_id, status,
        ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY started_at DESC) as rn
      FROM nexaas_memory.skill_runs
      WHERE started_at > now() - interval '2 hours'
    )
    SELECT skill_id, count(*) as consecutive
    FROM ranked
    WHERE rn <= 5 AND status = 'failed'
    GROUP BY skill_id
    HAVING count(*) >= 3
  `);

  for (const row of consecutiveFailures) {
    alerts.push({
      severity: "critical",
      component: `skill:${row.skill_id}`,
      message: `${row.consecutive} consecutive failures in the last 2 hours`,
    });
  }

  // 4. Stale skills — cadence-aware. The old flat ">120 min" threshold flagged
  // EVERY skill that ran >2h ago regardless of its schedule, so daily/weekly
  // skills (billing-health, billing-weekly, supplier-attribution-*, …) and
  // bursty event-driven skills (docuseal-webhook) were perpetually "stale" just
  // for being between runs — keeping the monitor stuck in `degraded`. Now we
  // only time-check skills with a genuine recurring cadence (≥3 runs in 14d,
  // typical gap ≥20 min) and flag one only when its silence exceeds 3× its OWN
  // median run-gap (floor 180 min ≈ a few missed runs). Self-calibrating: a
  // */30 skill alerts at ~3h silent; a daily skill not until ~3 days; a weekly
  // skill not until ~3 weeks. Event-driven/rare skills are exempt.
  const staleSkills = await sql<{ skill_id: string; minutes_since: string; median_gap: string }>(`
    WITH gaps AS (
      SELECT skill_id, started_at,
             started_at - lag(started_at) OVER (PARTITION BY skill_id ORDER BY started_at) AS gap
      FROM nexaas_memory.skill_runs
      WHERE started_at > now() - interval '14 days'
    ),
    agg AS (
      SELECT skill_id,
             max(started_at) AS last_run,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM gap) / 60) AS median_gap,
             count(gap) AS gap_count
      FROM gaps
      GROUP BY skill_id
    )
    SELECT skill_id,
           EXTRACT(EPOCH FROM now() - last_run) / 60 AS minutes_since,
           median_gap
    FROM agg
    WHERE gap_count >= 3
      AND median_gap >= 20
      AND EXTRACT(EPOCH FROM now() - last_run) / 60 > GREATEST(180, median_gap * 3)
  `);

  for (const row of staleSkills) {
    const mins = Math.round(parseFloat(row.minutes_since));
    const cadence = Math.round(parseFloat(row.median_gap));
    alerts.push({
      severity: "warning",
      component: `skill:${row.skill_id}`,
      message: `Hasn't run in ${mins} minutes (typical cadence ~${cadence} min)`,
    });
  }

  // 5. API credit check
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey || apiKey.includes("placeholder")) {
    alerts.push({ severity: "critical", component: "api", message: "Anthropic API key not set" });
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: probeModel(), max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      });
      if (res.status === 400 && (await res.text()).includes("credit balance")) {
        alerts.push({ severity: "critical", component: "api", message: "API credits exhausted" });
      } else if (res.status === 401) {
        alerts.push({ severity: "critical", component: "api", message: "API key invalid" });
      }
    } catch {
      alerts.push({ severity: "warning", component: "api", message: "Cannot verify API key (network error)" });
    }
  }

  // 6. Palace health
  const palaceCount = await sql<{ count: string }>(
    `SELECT count(*) FROM nexaas_memory.events WHERE workspace = $1 AND wing IS NOT NULL`, [workspace],
  );
  const palaceDrawers = parseInt(palaceCount[0]?.count ?? "0", 10);

  // 7. Redis
  const redisPong = await exec("redis-cli ping 2>/dev/null");
  if (redisPong !== "PONG") {
    alerts.push({ severity: "critical", component: "redis", message: "Redis not responding" });
  }

  // 8. Cost today
  const costToday = await sql<{ cost: string }>(`
    SELECT COALESCE(sum((payload->>'cost_usd')::numeric), 0) as cost
    FROM nexaas_memory.wal
    WHERE op = 'ai_skill_completed'
      AND created_at > date_trunc('day', now())
      AND payload->>'cost_usd' IS NOT NULL
  `);
  const apiCostToday = parseFloat(costToday[0]?.cost ?? "0");

  if (apiCostToday > 20) {
    alerts.push({ severity: "warning", component: "cost", message: `Daily API spend: $${apiCostToday.toFixed(2)} (above $20 threshold)` });
  }

  // 8b. Daily spend budget (#215). Tolerates a not-yet-migrated DB (the
  // spend_daily table arrives with migration 026) — health must not break
  // during the upgrade window.
  let spendBudget: HealthReport["metrics"]["spend_budget"] = null;
  try {
    const budgetRes = await sql<{ budget: string | null; spent: string | null; paused_day: string | null }>(
      `SELECT c.spend_daily_budget_usd::text AS budget,
              COALESCE(s.usd, 0)::text AS spent,
              (SELECT value FROM nexaas_memory.workspace_kv kv
                WHERE kv.workspace = c.workspace AND kv.key = 'spend_pause_active_day') AS paused_day
         FROM nexaas_memory.workspace_config c
         LEFT JOIN nexaas_memory.spend_daily s
           ON s.workspace = c.workspace
          AND s.day = (now() AT TIME ZONE c.timezone)::date
        WHERE c.workspace = $1`,
      [workspace],
    );
    const b = budgetRes[0];
    if (b?.budget) {
      const budgetUsd = parseFloat(b.budget);
      const spentUsd = parseFloat(b.spent ?? "0");
      const pct = budgetUsd > 0 ? Math.round((100 * spentUsd) / budgetUsd) : 0;
      spendBudget = { budget_usd: budgetUsd, spent_usd: spentUsd, paused: !!b.paused_day };
      if (b.paused_day) {
        alerts.push({
          severity: "critical",
          component: "spend-budget",
          message: "daily budget exceeded — queue paused (resumes at local midnight or via spend-override)",
        });
      } else if (pct >= 80) {
        alerts.push({
          severity: "warning",
          component: "spend-budget",
          message: `${pct}% of daily budget spent ($${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)})`,
        });
      }
    }
  } catch { /* pre-026 schema — no budget machinery yet */ }

  // 9. WAL count
  const walCount = await sql<{ count: string }>(
    `SELECT count(*) FROM nexaas_memory.wal WHERE workspace = $1`, [workspace],
  );

  // 10. System resources
  const memInfo = await exec("free -g 2>/dev/null");
  let memUsed = 0, memAvailable = 0;
  const memMatch = memInfo.match(/Mem:\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  if (memMatch) {
    memUsed = parseInt(memMatch[1]!, 10);
    memAvailable = parseInt(memMatch[2]!, 10);
  }

  const diskInfo = await exec("df -h / 2>/dev/null | tail -1");
  let diskPct = 0;
  const diskMatch = diskInfo.match(/(\d+)%/);
  if (diskMatch) diskPct = parseInt(diskMatch[1]!, 10);

  if (diskPct > 85) {
    alerts.push({ severity: "warning", component: "disk", message: `Disk usage at ${diskPct}%` });
  }
  if (memAvailable < 2) {
    alerts.push({ severity: "warning", component: "memory", message: `Only ${memAvailable}GB RAM available` });
  }

  // Skill health count
  const skillHealth = await sql<{ total: string; healthy: string; failing: string }>(`
    WITH recent AS (
      SELECT skill_id, status,
        ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY started_at DESC) as rn
      FROM nexaas_memory.skill_runs
      WHERE started_at > now() - interval '4 hours'
    )
    SELECT
      count(DISTINCT skill_id) as total,
      count(DISTINCT skill_id) FILTER (WHERE status = 'completed' AND rn = 1) as healthy,
      count(DISTINCT skill_id) FILTER (WHERE status = 'failed' AND rn = 1) as failing
    FROM recent WHERE rn = 1
  `);

  const overallStatus = alerts.some(a => a.severity === "critical") ? "critical"
    : alerts.some(a => a.severity === "warning") ? "degraded"
    : "healthy";

  const report: HealthReport = {
    timestamp: now,
    workspace,
    status: overallStatus,
    alerts,
    metrics: {
      worker_uptime_seconds: workerUptime,
      skills_total: parseInt(skillHealth[0]?.total ?? "0", 10),
      skills_healthy: parseInt(skillHealth[0]?.healthy ?? "0", 10),
      skills_failing: parseInt(skillHealth[0]?.failing ?? "0", 10),
      completions_last_hour: completionsLastHour,
      failures_last_hour: failuresLastHour,
      success_rate_last_hour: successRate,
      api_cost_today_usd: apiCostToday,
      spend_budget: spendBudget,
      wal_entries_total: parseInt(walCount[0]?.count ?? "0", 10),
      palace_drawers: palaceDrawers,
      memory_used_gb: memUsed,
      memory_available_gb: memAvailable,
      disk_used_pct: diskPct,
    },
  };

  return report;
}

export async function runAndRecord(workspace: string): Promise<HealthReport> {
  const report = await runHealthCheck(workspace);

  // Record as palace drawer
  await writeDrawerRaw(
    workspace,
    { wing: "ops", hall: "health", room: "monitor" },
    JSON.stringify(report),
    { eventType: "health-check", agentId: "health-monitor", skillId: "system/health-monitor" },
  );

  // WAL entry
  await appendWal({
    workspace,
    op: "health_check",
    actor: "system:health-monitor",
    payload: {
      status: report.status,
      alerts_count: report.alerts.length,
      success_rate: report.metrics.success_rate_last_hour,
      api_cost_today: report.metrics.api_cost_today_usd,
    },
  });

  return report;
}

export async function sendAlerts(report: HealthReport): Promise<void> {
  if (report.alerts.length === 0) return;

  const criticals = report.alerts.filter(a => a.severity === "critical");
  const warnings = report.alerts.filter(a => a.severity === "warning");

  let body = `Status: ${report.status.toUpperCase()}\n\n`;

  if (criticals.length > 0) {
    body += "Critical:\n";
    for (const a of criticals) body += `- ${a.component}: ${a.message}\n`;
    body += "\n";
  }

  if (warnings.length > 0) {
    body += "Warnings:\n";
    for (const a of warnings) body += `- ${a.component}: ${a.message}\n`;
    body += "\n";
  }

  body += `Success: ${report.metrics.success_rate_last_hour}% | Cost: $${report.metrics.api_cost_today_usd.toFixed(2)} | RAM: ${report.metrics.memory_available_gb}GB free`;

  const severity = criticals.length > 0 ? "critical" : "warning";

  await notify({
    workspace: report.workspace,
    severity,
    title: `Health ${report.status.toUpperCase()}`,
    body,
    component: "health-monitor",
    dedupeKey: `health-${report.workspace}-${report.status}`,
    dedupeWindowMinutes: severity === "critical" ? 5 : 30,
  });
}
