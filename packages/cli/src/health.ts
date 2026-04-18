/**
 * nexaas health — detailed health report with alerting status.
 */

import { createPool } from "@nexaas/palace";
import { runHealthCheck } from "../../runtime/src/tasks/health-monitor.js";

export async function run() {
  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  createPool();

  console.log("\n  Running health check...\n");
  const report = await runHealthCheck(workspace);

  const statusIcon = report.status === "healthy" ? "✓" : report.status === "degraded" ? "⚠" : "✗";
  console.log(`  ${statusIcon} Overall: ${report.status.toUpperCase()}\n`);

  // Metrics
  console.log("  Metrics:");
  console.log(`    Worker uptime:      ${Math.round(report.metrics.worker_uptime_seconds)}s`);
  console.log(`    Skills:             ${report.metrics.skills_healthy}/${report.metrics.skills_total} healthy`);
  console.log(`    Last hour:          ${report.metrics.completions_last_hour} ok, ${report.metrics.failures_last_hour} fail (${report.metrics.success_rate_last_hour}%)`);
  console.log(`    API cost today:     $${report.metrics.api_cost_today_usd.toFixed(2)}`);
  console.log(`    WAL entries:        ${report.metrics.wal_entries_total}`);
  console.log(`    Palace drawers:     ${report.metrics.palace_drawers}`);
  console.log(`    Memory:             ${report.metrics.memory_used_gb}GB used, ${report.metrics.memory_available_gb}GB available`);
  console.log(`    Disk:               ${report.metrics.disk_used_pct}% used`);

  // Alerts
  if (report.alerts.length > 0) {
    console.log("\n  Alerts:");
    for (const alert of report.alerts) {
      const icon = alert.severity === "critical" ? "🔴" : alert.severity === "warning" ? "🟡" : "🔵";
      console.log(`    ${icon} [${alert.component}] ${alert.message}`);
    }
  } else {
    console.log("\n  ✓ No alerts");
  }

  console.log("");
  process.exit(report.status === "critical" ? 1 : 0);
}
