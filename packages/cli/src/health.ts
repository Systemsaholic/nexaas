/**
 * nexaas health — detailed health report.
 *
 * Thin renderer over the runtime's `runHealthCheck` (#256) — the same
 * checks the in-process 5-minute health monitor runs, plus a live probe
 * of the worker's HTTP endpoint (which the in-process monitor must skip —
 * self-curling your own event loop is the #33 deadlock class). Before the
 * fold this file was a second, diverging implementation: #245's
 * cadence-aware staleness never made it here, and #215's spend budget
 * never made it into the monitor.
 */

import { runHealthCheck } from "@nexaas/runtime";
import { getPool } from "@nexaas/palace";

export async function run() {
  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  console.log("\n  Running health check...\n");

  const report = await runHealthCheck(workspace, { probeWorker: true });
  const m = report.metrics;

  const status = report.status.toUpperCase();
  const icon = report.status === "healthy" ? "✓" : report.status === "degraded" ? "⚠" : "✗";

  const budgetLine = m.spend_budget
    ? `$${m.spend_budget.spent_usd.toFixed(2)} of $${m.spend_budget.budget_usd.toFixed(2)}` +
      ` (${m.spend_budget.budget_usd > 0 ? Math.round((100 * m.spend_budget.spent_usd) / m.spend_budget.budget_usd) : 0}%)` +
      `${m.spend_budget.paused ? " — QUEUE PAUSED" : ""}`
    : "(unlimited)";

  console.log(`  ${icon} Overall: ${status}\n`);
  console.log("  Metrics:");
  console.log(`    Worker uptime:      ${Math.round(m.worker_uptime_seconds)}s`);
  console.log(`    Last hour:          ${m.completions_last_hour} ok, ${m.failures_last_hour} fail (${m.success_rate_last_hour}%)`);
  console.log(`    Skills (4h):        ${m.skills_total} seen, ${m.skills_healthy} healthy, ${m.skills_failing} failing`);
  console.log(`    API cost today:     $${m.api_cost_today_usd.toFixed(2)}`);
  console.log(`    Spend budget:       ${budgetLine}`);
  console.log(`    WAL entries:        ${m.wal_entries_total}`);
  console.log(`    Palace drawers:     ${m.palace_drawers}`);
  console.log(`    Memory:             ${m.memory_used_gb}GB used, ${m.memory_available_gb}GB available`);
  console.log(`    Disk:               ${m.disk_used_pct}% used`);

  if (report.alerts.length > 0) {
    console.log("\n  Alerts:");
    for (const a of report.alerts) {
      const i = a.severity === "critical" ? "🔴" : a.severity === "warning" ? "🟡" : "🔵";
      console.log(`    ${i} [${a.component}] ${a.message}`);
    }
  } else {
    console.log("\n  ✓ No alerts");
  }
  console.log("");

  await getPool().end().catch(() => {});
  process.exit(report.status === "critical" ? 1 : 0);
}
