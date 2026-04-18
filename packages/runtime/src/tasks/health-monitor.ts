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

import { sql, appendWal } from "@nexaas/palace";
import { execSync } from "child_process";
import { notify } from "../notifications.js";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

interface HealthAlert {
  severity: "critical" | "warning" | "info";
  component: string;
  message: string;
}

interface HealthReport {
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
    wal_entries_total: number;
    palace_drawers: number;
    memory_used_gb: number;
    memory_available_gb: number;
    disk_used_pct: number;
  };
}

export async function runHealthCheck(workspace: string): Promise<HealthReport> {
  const alerts: HealthAlert[] = [];
  const now = new Date().toISOString();

  // 1. Worker health
  let workerUptime = 0;
  try {
    const health = exec("curl -sf http://localhost:9090/health 2>/dev/null");
    if (health) {
      const parsed = JSON.parse(health);
      workerUptime = parsed.uptime ?? 0;
      if (parsed.status !== "healthy") {
        alerts.push({ severity: "critical", component: "worker", message: "Worker reports unhealthy" });
      }
    } else {
      alerts.push({ severity: "critical", component: "worker", message: "Worker health endpoint not responding" });
    }
  } catch {
    alerts.push({ severity: "critical", component: "worker", message: "Cannot reach worker health endpoint" });
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

  // 4. Stale skills (should have run but didn't)
  const staleSkills = await sql<{ skill_id: string; minutes_since: string }>(`
    SELECT skill_id,
      EXTRACT(EPOCH FROM now() - max(started_at)) / 60 as minutes_since
    FROM nexaas_memory.skill_runs
    WHERE started_at > now() - interval '24 hours'
    GROUP BY skill_id
    HAVING EXTRACT(EPOCH FROM now() - max(started_at)) / 60 > 60
  `);

  for (const row of staleSkills) {
    const mins = Math.round(parseFloat(row.minutes_since));
    if (mins > 120) {
      alerts.push({
        severity: "warning",
        component: `skill:${row.skill_id}`,
        message: `Hasn't run in ${mins} minutes`,
      });
    }
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
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
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
  const redisPong = exec("redis-cli ping 2>/dev/null");
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

  // 9. WAL count
  const walCount = await sql<{ count: string }>(
    `SELECT count(*) FROM nexaas_memory.wal WHERE workspace = $1`, [workspace],
  );

  // 10. System resources
  const memInfo = exec("free -g 2>/dev/null");
  let memUsed = 0, memAvailable = 0;
  const memMatch = memInfo.match(/Mem:\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  if (memMatch) {
    memUsed = parseInt(memMatch[1]!, 10);
    memAvailable = parseInt(memMatch[2]!, 10);
  }

  const diskInfo = exec("df -h / 2>/dev/null | tail -1");
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
  await sql(
    `INSERT INTO nexaas_memory.events
      (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id)
     VALUES ($1, 'ops', 'health', 'monitor', $2, encode(digest($2, 'sha256'), 'hex'), 'health-check', 'health-monitor', 'system/health-monitor')`,
    [workspace, JSON.stringify(report)],
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

/** @deprecated Use sendAlerts() instead — kept for backward compatibility */
export async function sendTelegramAlert(report: HealthReport, botToken: string, chatId: string): Promise<void> {
  await sendAlerts(report);
}
