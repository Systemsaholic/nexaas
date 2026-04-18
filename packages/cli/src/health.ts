/**
 * nexaas health — detailed health report.
 * Self-contained (no cross-package imports) — queries DB and services directly.
 */

import { execSync } from "child_process";
import pg from "pg";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

export async function run() {
  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const alerts: Array<{ sev: string; comp: string; msg: string }> = [];

  console.log("\n  Running health check...\n");

  // Worker
  let uptime = 0;
  try {
    const h = JSON.parse(exec("curl -sf http://localhost:9090/health 2>/dev/null") || "{}");
    uptime = h.uptime ?? 0;
    if (h.status !== "healthy") alerts.push({ sev: "critical", comp: "worker", msg: "unhealthy" });
  } catch { alerts.push({ sev: "critical", comp: "worker", msg: "not responding" }); }

  // Redis
  if (exec("redis-cli ping 2>/dev/null") !== "PONG") {
    alerts.push({ sev: "critical", comp: "redis", msg: "not responding" });
  }

  // Success rate last hour
  const hr = await pool.query(`
    SELECT count(*) FILTER (WHERE status = 'completed') as ok,
           count(*) FILTER (WHERE status = 'failed') as fail
    FROM nexaas_memory.skill_runs
    WHERE started_at > now() - interval '1 hour' AND status IN ('completed','failed')
  `);
  const ok = parseInt(hr.rows[0]?.ok ?? "0", 10);
  const fail = parseInt(hr.rows[0]?.fail ?? "0", 10);
  const total = ok + fail;
  const rate = total > 0 ? Math.round(100 * ok / total) : 100;
  if (rate < 80 && total > 5) alerts.push({ sev: "warning", comp: "skills", msg: `${rate}% success rate (${fail} failures)` });

  // Consecutive failures
  const consec = await pool.query(`
    WITH ranked AS (
      SELECT skill_id, status, ROW_NUMBER() OVER (PARTITION BY skill_id ORDER BY started_at DESC) as rn
      FROM nexaas_memory.skill_runs WHERE started_at > now() - interval '2 hours'
    )
    SELECT skill_id, count(*) as c FROM ranked WHERE rn <= 5 AND status = 'failed' GROUP BY skill_id HAVING count(*) >= 3
  `);
  for (const r of consec.rows) {
    alerts.push({ sev: "critical", comp: r.skill_id, msg: `${r.c} consecutive failures` });
  }

  // API key
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey || apiKey.includes("placeholder")) {
    alerts.push({ sev: "critical", comp: "api", msg: "not set" });
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      });
      if (res.status === 400 && (await res.text()).includes("credit")) alerts.push({ sev: "critical", comp: "api", msg: "credits exhausted" });
      else if (res.status === 401) alerts.push({ sev: "critical", comp: "api", msg: "key invalid" });
    } catch { /* network error, skip */ }
  }

  // Cost today
  const costRes = await pool.query(`
    SELECT COALESCE(sum((payload->>'cost_usd')::numeric), 0) as cost
    FROM nexaas_memory.wal WHERE op = 'ai_skill_completed' AND created_at > date_trunc('day', now()) AND payload->>'cost_usd' IS NOT NULL
  `);
  const cost = parseFloat(costRes.rows[0]?.cost ?? "0");
  if (cost > 20) alerts.push({ sev: "warning", comp: "cost", msg: `$${cost.toFixed(2)} today` });

  // Counts
  const walRes = await pool.query(`SELECT count(*) FROM nexaas_memory.wal WHERE workspace = $1`, [workspace]);
  const palaceRes = await pool.query(`SELECT count(*) FROM nexaas_memory.events WHERE workspace = $1 AND wing IS NOT NULL`, [workspace]);

  // System
  const memInfo = exec("free -g 2>/dev/null");
  let memUsed = 0, memAvail = 0;
  const mm = memInfo.match(/Mem:\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  if (mm) { memUsed = parseInt(mm[1]!, 10); memAvail = parseInt(mm[2]!, 10); }
  const diskPct = parseInt(exec("df -h / | tail -1").match(/(\d+)%/)?.[1] ?? "0", 10);
  if (diskPct > 85) alerts.push({ sev: "warning", comp: "disk", msg: `${diskPct}% used` });
  if (memAvail < 2) alerts.push({ sev: "warning", comp: "memory", msg: `${memAvail}GB available` });

  // Report
  const status = alerts.some(a => a.sev === "critical") ? "CRITICAL" : alerts.some(a => a.sev === "warning") ? "DEGRADED" : "HEALTHY";
  const icon = status === "HEALTHY" ? "✓" : status === "DEGRADED" ? "⚠" : "✗";

  console.log(`  ${icon} Overall: ${status}\n`);
  console.log("  Metrics:");
  console.log(`    Worker uptime:      ${Math.round(uptime)}s`);
  console.log(`    Last hour:          ${ok} ok, ${fail} fail (${rate}%)`);
  console.log(`    API cost today:     $${cost.toFixed(2)}`);
  console.log(`    WAL entries:        ${walRes.rows[0]?.count}`);
  console.log(`    Palace drawers:     ${palaceRes.rows[0]?.count}`);
  console.log(`    Memory:             ${memUsed}GB used, ${memAvail}GB available`);
  console.log(`    Disk:               ${diskPct}% used`);

  if (alerts.length > 0) {
    console.log("\n  Alerts:");
    for (const a of alerts) {
      const i = a.sev === "critical" ? "🔴" : a.sev === "warning" ? "🟡" : "🔵";
      console.log(`    ${i} [${a.comp}] ${a.msg}`);
    }
  } else {
    console.log("\n  ✓ No alerts");
  }
  console.log("");

  await pool.end();
  process.exit(status === "CRITICAL" ? 1 : 0);
}
