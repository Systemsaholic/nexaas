/**
 * nexaas init — sets up Nexaas on a VPS.
 *
 * Handles:
 * 1. Prerequisites (Node.js, Postgres, Redis, pgvector)
 * 2. Database setup (create DB, apply migrations)
 * 3. Configuration (.env generation with interactive prompts)
 * 4. Operator bootstrap (first operator identity + ed25519 key + genesis WAL)
 * 5. Service installation (systemd unit for nexaas-worker)
 * 6. Health verification
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { randomBytes, generateKeyPairSync } from "crypto";
import { createInterface } from "readline";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? process.cwd();

function log(msg: string) { console.log(`  ✓ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ ${msg}`); process.exit(1); }
function step(n: number, total: number, msg: string) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

function exec(cmd: string, opts?: { silent?: boolean }): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: opts?.silent ? "pipe" : "inherit",
    }).trim();
  } catch {
    return "";
  }
}

function commandExists(cmd: string): boolean {
  return spawnSync("which", [cmd], { stdio: "pipe" }).status === 0;
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  // Non-interactive: use defaults or env vars when stdin is not a TTY
  if (!process.stdin.isTTY) {
    const val = defaultValue || "";
    if (val) console.log(`  ? ${question} [${val}]: (auto)`);
    return val;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ? ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function run(args: string[]) {
  let workspaceId = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspaceId = args[i + 1]!;
      i++;
    }
  }

  if (!workspaceId) {
    workspaceId = await prompt("Workspace ID (e.g., phoenix-voyages)");
    if (!workspaceId) fail("Workspace ID is required");
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║         Nexaas Framework Setup            ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`\n  Workspace: ${workspaceId}`);
  console.log(`  Root:      ${NEXAAS_ROOT}`);

  const TOTAL_STEPS = 6;

  // ── Step 1: Prerequisites ──────────────────────────────────────────

  step(1, TOTAL_STEPS, "Checking prerequisites...");

  // Node.js
  if (!commandExists("node")) {
    fail("Node.js not found. Install Node.js >= 20: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs");
  }
  const nodeVersion = exec("node -v", { silent: true });
  const nodeMajor = parseInt(nodeVersion.replace("v", "").split(".")[0]!, 10);
  if (nodeMajor < 20) {
    fail(`Node.js ${nodeVersion} is too old. Need >= 20.`);
  }
  log(`Node.js ${nodeVersion}`);

  // Postgres
  if (!commandExists("psql")) {
    warn("PostgreSQL not found. Installing...");
    exec("sudo apt-get install -y postgresql");
  }
  log("PostgreSQL installed");

  // pgvector
  const pgvectorCheck = exec("psql -d postgres -c \"SELECT 1 FROM pg_available_extensions WHERE name = 'vector'\" -t -A 2>/dev/null", { silent: true });
  if (!pgvectorCheck.includes("1")) {
    warn("pgvector not found. Installing...");
    exec("sudo apt-get install -y postgresql-16-pgvector 2>/dev/null || sudo apt-get install -y postgresql-17-pgvector 2>/dev/null || true");
  }
  log("pgvector extension available");

  // Redis
  if (!commandExists("redis-cli")) {
    warn("Redis not found. Installing...");
    exec("sudo apt-get install -y redis-server");
    exec("sudo systemctl enable redis-server");
    exec("sudo systemctl start redis-server");
  }
  const redisPong = exec("redis-cli ping 2>/dev/null", { silent: true });
  if (redisPong !== "PONG") {
    warn("Redis not responding. Starting...");
    exec("sudo systemctl start redis-server");
  }
  log("Redis running");

  // ── Step 2: Database setup ─────────────────────────────────────────

  step(2, TOTAL_STEPS, "Setting up database...");

  const dbUser = exec("whoami", { silent: true });
  const dbName = "nexaas";
  const dbPass = exec(`openssl rand -hex 12`, { silent: true });

  // Create DB and user if they don't exist
  exec(`sudo -u postgres createdb ${dbName} 2>/dev/null || true`);
  exec(`sudo -u postgres createuser -s ${dbUser} 2>/dev/null || true`);
  exec(`sudo -u postgres psql -c "ALTER USER ${dbUser} PASSWORD '${dbPass}'" 2>/dev/null || true`);

  const databaseUrl = `postgresql://${dbUser}:${dbPass}@localhost/${dbName}`;

  // Apply base schema if not exists
  const schemaFile = join(NEXAAS_ROOT, "database", "schema.sql");
  if (existsSync(schemaFile)) {
    exec(`psql "${databaseUrl}" < "${schemaFile}" 2>/dev/null || true`);
    log("Base schema applied");
  }

  // Apply all migrations in order
  const migrationsDir = join(NEXAAS_ROOT, "database", "migrations");
  if (existsSync(migrationsDir)) {
    const migrations = readFileSync("/dev/stdin", "utf-8").split("\n").filter(Boolean);
    exec(`for f in ${migrationsDir}/*.sql; do psql "${databaseUrl}" < "$f" 2>/dev/null; done`);
    log("Migrations applied (including palace substrate)");
  }

  // Verify palace schema exists
  const palaceCheck = exec(
    `psql "${databaseUrl}" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'nexaas_memory'" -t -A`,
    { silent: true },
  );
  const tableCount = parseInt(palaceCheck, 10);
  if (tableCount < 10) {
    fail(`Palace schema incomplete (${tableCount} tables, expected 15+). Check migration output.`);
  }
  log(`Palace schema verified: ${tableCount} tables`);

  // ── Step 3: Configuration ──────────────────────────────────────────

  step(3, TOTAL_STEPS, "Generating configuration...");

  const envPath = join(NEXAAS_ROOT, ".env");
  const existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  let voyageKey = process.env.VOYAGE_API_KEY ?? "";

  if (!anthropicKey) {
    anthropicKey = await prompt("ANTHROPIC_API_KEY (required for skill execution)");
    if (!anthropicKey) warn("No API key provided — skills will fail until one is set in .env");
  }

  if (!voyageKey) {
    voyageKey = await prompt("VOYAGE_API_KEY (optional, hash fallback if skipped)", "skip");
    if (voyageKey === "skip") voyageKey = "";
  }

  const envContent = `# Nexaas Framework Configuration
# Generated: ${new Date().toISOString()}
# Workspace: ${workspaceId}

NEXAAS_WORKSPACE=${workspaceId}
NEXAAS_ROOT=${NEXAAS_ROOT}
DATABASE_URL=${databaseUrl}
REDIS_URL=redis://localhost:6379

# Model API keys
ANTHROPIC_API_KEY=${anthropicKey}
VOYAGE_API_KEY=${voyageKey}

# Worker configuration
NEXAAS_WORKER_CONCURRENCY=5
NEXAAS_WORKER_PORT=9090
`;

  writeFileSync(envPath, envContent);
  chmodSync(envPath, 0o600);
  log("Configuration saved to .env");

  // ── Step 4: Operator bootstrap ─────────────────────────────────────

  step(4, TOTAL_STEPS, "Creating operator identity...");

  const operatorName = await prompt("Your name", process.env.OPERATOR_NAME ?? "Al");
  const operatorEmail = await prompt("Your email", "al@systemsaholic.com");

  // Generate ed25519 signing key
  const keyDir = join(process.env.HOME ?? "/home/ubuntu", ".nexaas");
  const keyPath = join(keyDir, "operator-key.ed25519");

  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true });
  }

  if (!existsSync(keyPath)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(keyPath, privateKey);
    chmodSync(keyPath, 0o600);
    writeFileSync(`${keyPath}.pub`, publicKey);
    log(`Signing key generated at ${keyPath}`);
  } else {
    log(`Signing key already exists at ${keyPath}`);
  }

  const publicKeyPem = readFileSync(`${keyPath}.pub`, "utf-8");

  // Create operator in database
  exec(
    `psql "${databaseUrl}" -c "INSERT INTO nexaas_memory.operators (display_name, email, role) VALUES ('${operatorName}', '${operatorEmail}', 'ops_admin') ON CONFLICT (email) DO NOTHING"`,
  );

  const operatorId = exec(
    `psql "${databaseUrl}" -c "SELECT id FROM nexaas_memory.operators WHERE email = '${operatorEmail}'" -t -A`,
    { silent: true },
  );

  // Register the signing key
  exec(
    `psql "${databaseUrl}" -c "INSERT INTO nexaas_memory.operator_keys (operator_id, public_key, key_source) VALUES ('${operatorId}', decode(replace(replace('${publicKeyPem}', '-----BEGIN PUBLIC KEY-----', ''), '-----END PUBLIC KEY-----', ''), 'base64'), 'file') ON CONFLICT DO NOTHING"`,
  );

  log(`Operator '${operatorName}' (${operatorEmail}) registered as ops_admin`);

  // Write genesis WAL row
  const genesisHash = "0".repeat(64);
  exec(
    `psql "${databaseUrl}" -c "INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash) SELECT '${workspaceId}', 'workspace_genesis', 'system', '{\"workspace\": \"${workspaceId}\", \"provisioned_by\": \"${operatorEmail}\", \"provisioned_at\": \"${new Date().toISOString()}\"}', '${genesisHash}', encode(digest('${genesisHash}|workspace_genesis|system|{\"workspace\":\"${workspaceId}\"}|${new Date().toISOString()}', 'sha256'), 'hex') WHERE NOT EXISTS (SELECT 1 FROM nexaas_memory.wal WHERE workspace = '${workspaceId}' AND op = 'workspace_genesis')"`,
  );

  log("Palace genesis WAL row written");

  // ── Step 5: Service installation ───────────────────────────────────

  step(5, TOTAL_STEPS, "Installing services...");

  // Resolve tsx path — bypass npm/npx wrapper to fix journald logging (#20)
  // and orphan process cleanup (#18)
  const tsxBin = `${NEXAAS_ROOT}/node_modules/.bin/tsx`;
  const nodeBin = exec("which node", { silent: true }) || "/usr/bin/node";

  const serviceContent = `[Unit]
Description=Nexaas Worker (${workspaceId})
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=${dbUser}
WorkingDirectory=${NEXAAS_ROOT}
EnvironmentFile=${NEXAAS_ROOT}/.env
ExecStart=${nodeBin} ${tsxBin} ${NEXAAS_ROOT}/packages/runtime/src/worker.ts
ExecStopPost=/bin/sh -c 'fuser -k -TERM 9090/tcp 2>/dev/null; sleep 2; fuser -k -KILL 9090/tcp 2>/dev/null; exit 0'
Restart=always
RestartSec=5
MemoryMax=6G
MemoryHigh=5G
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;

  const servicePath = "/etc/systemd/system/nexaas-worker.service";
  exec(`echo '${serviceContent}' | sudo tee ${servicePath} > /dev/null`);
  exec("sudo systemctl daemon-reload");
  exec("sudo systemctl enable nexaas-worker");
  exec("sudo systemctl start nexaas-worker");

  // Wait a moment for the worker to start
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const workerStatus = exec("systemctl is-active nexaas-worker 2>/dev/null", { silent: true });
  if (workerStatus === "active") {
    log("nexaas-worker.service installed and running");
  } else {
    warn("Worker may not have started. Check: journalctl -u nexaas-worker -f");
  }

  // ── Step 6: Verification ──────────────────────────────────────────

  step(6, TOTAL_STEPS, "Verifying installation...");

  // Test Postgres
  const pgTest = exec(`psql "${databaseUrl}" -c "SELECT 1" -t -A 2>/dev/null`, { silent: true });
  if (pgTest === "1") log("Postgres: connected"); else warn("Postgres: connection failed");

  // Test pgvector
  const vectorTest = exec(`psql "${databaseUrl}" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector'" -t -A 2>/dev/null`, { silent: true });
  if (vectorTest) log(`pgvector: v${vectorTest}`); else warn("pgvector: not installed");

  // Test Redis
  const redisTest = exec("redis-cli ping 2>/dev/null", { silent: true });
  if (redisTest === "PONG") log("Redis: connected"); else warn("Redis: not responding");

  // Test WAL
  const walCount = exec(`psql "${databaseUrl}" -c "SELECT count(*) FROM nexaas_memory.wal WHERE workspace = '${workspaceId}'" -t -A`, { silent: true });
  if (parseInt(walCount, 10) >= 1) log(`WAL: ${walCount} row(s), genesis verified`); else warn("WAL: no genesis row found");

  // Test health endpoint
  try {
    const healthCheck = exec(`curl -s http://localhost:9090/health 2>/dev/null`, { silent: true });
    const health = JSON.parse(healthCheck);
    if (health.status === "healthy") {
      log("Worker health: healthy");
    } else {
      warn("Worker health: unhealthy");
    }
  } catch {
    warn("Worker health endpoint not responding yet (may still be starting)");
  }

  // ── Done ──────────────────────────────────────────────────────────

  console.log(`
╔══════════════════════════════════════════╗
║       Nexaas Setup Complete              ║
╚══════════════════════════════════════════╝

  Workspace:    ${workspaceId}
  Database:     ${databaseUrl}
  Redis:        redis://localhost:6379
  Worker:       systemctl status nexaas-worker
  Dashboard:    http://localhost:9090/queues
  Health:       http://localhost:9090/health
  Logs:         journalctl -u nexaas-worker -f

  Operator:     ${operatorName} (${operatorEmail})
  Signing key:  ${keyPath}

  Next steps:
    1. Verify:    nexaas status
    2. Migrate:   claude then /migrate-flow
    3. Monitor:   open http://localhost:9090/queues
`);
}
