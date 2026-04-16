/**
 * nexaas status — check Nexaas runtime health at a glance.
 */

import { execSync } from "child_process";

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

export async function run() {
  const workspace = process.env.NEXAAS_WORKSPACE ?? "unknown";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const port = process.env.NEXAAS_WORKER_PORT ?? "9090";

  console.log(`\n  Nexaas Status — ${workspace}\n`);

  // Worker service
  const workerActive = exec("systemctl is-active nexaas-worker 2>/dev/null");
  const workerIcon = workerActive === "active" ? "✓" : "✗";
  console.log(`  ${workerIcon} Worker:     ${workerActive || "not found"}`);

  // Redis
  const redisPong = exec("redis-cli ping 2>/dev/null");
  const redisIcon = redisPong === "PONG" ? "✓" : "✗";
  console.log(`  ${redisIcon} Redis:      ${redisPong === "PONG" ? "connected" : "not responding"}`);

  // Postgres
  const pgTest = exec(`psql "${dbUrl}" -c "SELECT 1" -t -A 2>/dev/null`);
  const pgIcon = pgTest === "1" ? "✓" : "✗";
  console.log(`  ${pgIcon} Postgres:   ${pgTest === "1" ? "connected" : "not responding"}`);

  // pgvector
  const vectorVer = exec(`psql "${dbUrl}" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector'" -t -A 2>/dev/null`);
  const vectorIcon = vectorVer ? "✓" : "✗";
  console.log(`  ${vectorIcon} pgvector:   ${vectorVer ? `v${vectorVer}` : "not installed"}`);

  // Palace tables
  const tableCount = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'nexaas_memory'" -t -A 2>/dev/null`);
  const palaceIcon = parseInt(tableCount, 10) >= 10 ? "✓" : "✗";
  console.log(`  ${palaceIcon} Palace:     ${tableCount} tables`);

  // WAL chain
  const walCount = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM nexaas_memory.wal WHERE workspace = '${workspace}'" -t -A 2>/dev/null`);
  console.log(`  ✓ WAL:        ${walCount} rows`);

  // Active runs
  const activeRuns = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM nexaas_memory.skill_runs WHERE workspace = '${workspace}' AND status IN ('running', 'waiting')" -t -A 2>/dev/null`);
  console.log(`  ✓ Active runs: ${activeRuns}`);

  // Health endpoint
  let healthStatus = "unreachable";
  try {
    const healthJson = exec(`curl -s http://localhost:${port}/health 2>/dev/null`);
    if (healthJson) {
      const health = JSON.parse(healthJson);
      healthStatus = `${health.status} (uptime: ${Math.round(health.uptime)}s)`;
    }
  } catch { /* ignore */ }
  const healthIcon = healthStatus.startsWith("healthy") ? "✓" : "⚠";
  console.log(`  ${healthIcon} Health:     ${healthStatus}`);

  // Dashboard URL
  console.log(`\n  Dashboard:    http://localhost:${port}/queues`);
  console.log(`  Logs:         journalctl -u nexaas-worker -f\n`);
}
