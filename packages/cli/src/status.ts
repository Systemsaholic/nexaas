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

async function testAnthropicKey(): Promise<{ valid: boolean; error?: string }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "" || key.includes("placeholder")) {
    return { valid: false, error: "not set" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "invalid key" };
    if (res.status === 403) return { valid: false, error: "forbidden" };
    // 429 or other errors mean the key works but we hit a limit
    if (res.status === 429) return { valid: true };
    return { valid: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { valid: false, error: "network error" };
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

  // Anthropic API key
  const keyResult = await testAnthropicKey();
  const keyIcon = keyResult.valid ? "✓" : "✗";
  const keyStatus = keyResult.valid ? "valid" : keyResult.error ?? "failed";
  console.log(`  ${keyIcon} API key:    ${keyStatus}`);

  // Voyage API key
  const voyageKey = process.env.VOYAGE_API_KEY;
  const voyageIcon = voyageKey && voyageKey !== "" ? "✓" : "⚠";
  const voyageStatus = voyageKey && voyageKey !== "" ? "set" : "not set (hash fallback for RAG)";
  console.log(`  ${voyageIcon} Voyage key: ${voyageStatus}`);

  // WAL chain
  const walCount = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM nexaas_memory.wal WHERE workspace = '${workspace}'" -t -A 2>/dev/null`);
  console.log(`  ✓ WAL:        ${walCount} rows`);

  // Active runs
  const activeRuns = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM nexaas_memory.skill_runs WHERE workspace = '${workspace}' AND status IN ('running', 'waiting')" -t -A 2>/dev/null`);
  console.log(`  ✓ Active runs: ${activeRuns}`);

  // Registered workspaces
  const workspaces = exec(`psql "${dbUrl}" -c "SELECT DISTINCT workspace FROM nexaas_memory.wal WHERE op = 'workspace_genesis' ORDER BY workspace" -t -A 2>/dev/null`);
  if (workspaces) {
    console.log(`\n  Workspaces:`);
    for (const ws of workspaces.split("\n")) {
      if (ws.trim()) console.log(`    • ${ws.trim()}`);
    }
  }

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
  console.log(`\n  ${healthIcon} Health:     ${healthStatus}`);

  // Dashboard URL
  console.log(`\n  Dashboard:    http://localhost:${port}/queues`);
  console.log(`  Logs:         journalctl -u nexaas-worker -f\n`);
}
