/**
 * nexaas onboard — discover, analyze, and register a workspace.
 *
 * Scans a workspace directory, inventories automation flows,
 * classifies risk tiers, detects cross-workspace dependencies,
 * generates a migration plan, and updates CLAUDE.md.
 *
 * Usage:
 *   nexaas onboard --workspace ~/Phoenix-Voyages --id phoenix-voyages
 *   nexaas onboard --workspace ~/Accounting --id phoenix-accounting
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

interface DiscoveredFlow {
  name: string;
  source: string;           // trigger-dev | n8n | cron | python-script | shell-script
  file: string;
  schedule?: string;
  triggerType: string;       // cron | webhook | event | manual
  description: string;
  integrations: string[];
  hasWaitpoints: boolean;
  hasApprovalGate: boolean;
  riskTier: number;          // 1-5
  crossWorkspaceDeps: string[];
}

interface OnboardResult {
  workspaceId: string;
  workspacePath: string;
  flows: DiscoveredFlow[];
  crossWorkspaceRelationships: Array<{ from: string; to: string; via: string }>;
  migrationOrder: DiscoveredFlow[];
}

function discoverTriggerDevTasks(workspacePath: string): DiscoveredFlow[] {
  const flows: DiscoveredFlow[] = [];
  const triggerDirs = [
    join(workspacePath, "trigger-dev", "src", "trigger"),
    join(workspacePath, "trigger", "tasks"),
  ];

  for (const dir of triggerDirs) {
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter(f => f.endsWith(".ts"));
    for (const file of files) {
      const filePath = join(dir, file);
      const content = readFileSync(filePath, "utf-8");
      const name = file.replace(".ts", "");

      // Detect schedules
      const scheduleMatch = content.match(/cron:\s*["']([^"']+)["']/);
      const schedule = scheduleMatch?.[1];

      // Detect waitpoints
      const hasWaitpoints = content.includes("wait.createToken") || content.includes("wait.forToken") || content.includes("waitForEvent");

      // Detect approval gates
      const hasApprovalGate = content.includes("approval") || content.includes("approve") || content.includes("waitpoint");

      // Detect integrations (MCP calls, API references)
      const integrations: string[] = [];
      if (content.includes("email") || content.includes("Email")) integrations.push("email");
      if (content.includes("telegram") || content.includes("Telegram")) integrations.push("telegram");
      if (content.includes("stripe") || content.includes("Stripe")) integrations.push("stripe");
      if (content.includes("plaid") || content.includes("Plaid")) integrations.push("plaid");
      if (content.includes("quickbooks") || content.includes("qbo") || content.includes("QBO")) integrations.push("qbo");
      if (content.includes("firecrawl") || content.includes("scrape")) integrations.push("firecrawl");
      if (content.includes("traveltek") || content.includes("cruise")) integrations.push("traveltek");
      if (content.includes("paperless")) integrations.push("paperless");
      if (content.includes("wordpress") || content.includes("wp-cli")) integrations.push("wordpress");
      if (content.includes("playwright") || content.includes("browser")) integrations.push("playwright");
      if (content.includes("buffer") || content.includes("social")) integrations.push("social");

      // Detect cross-workspace references
      const crossWorkspaceDeps: string[] = [];
      if (content.includes("Accounting") || content.includes("accounting")) crossWorkspaceDeps.push("accounting");
      if (content.includes("Phoenix-Voyages") && dir.includes("Accounting")) crossWorkspaceDeps.push("phoenix-voyages");

      // Detect trigger type
      let triggerType = "manual";
      if (schedule) triggerType = "cron";
      if (content.includes("webhook")) triggerType = "webhook";
      if (content.includes("triggerAndWait") || content.includes(".trigger(")) triggerType = "event";
      if (schedule) triggerType = "cron";

      // Extract description from comments
      const commentMatch = content.match(/\/\*\*?\s*\n\s*\*?\s*(.+?)[\n*]/);
      const description = commentMatch?.[1]?.trim() ?? `Trigger.dev task: ${name}`;

      // Classify risk tier
      let riskTier = 1;
      if (integrations.includes("email") && content.includes("send")) riskTier = Math.max(riskTier, 3);
      if (integrations.includes("social")) riskTier = Math.max(riskTier, 3);
      if (integrations.includes("qbo") || integrations.includes("stripe")) riskTier = Math.max(riskTier, 4);
      if (integrations.includes("wordpress") && content.includes("create")) riskTier = Math.max(riskTier, 3);
      if (hasWaitpoints || hasApprovalGate) riskTier = Math.max(riskTier, 3);
      if (content.includes("register_promotion")) riskTier = Math.max(riskTier, 4);
      if (content.includes("trust") || content.includes("Trust")) riskTier = 5;
      if (!integrations.some(i => ["email", "social", "qbo", "stripe", "wordpress"].includes(i))) {
        if (riskTier < 2) riskTier = 1;
      }

      flows.push({
        name, source: "trigger-dev", file: filePath,
        schedule, triggerType, description, integrations,
        hasWaitpoints, hasApprovalGate, riskTier, crossWorkspaceDeps,
      });
    }
  }

  return flows;
}

function discoverPythonScripts(workspacePath: string): DiscoveredFlow[] {
  const flows: DiscoveredFlow[] = [];
  const pyDirs = ["imports", "receipts", "reconciliation", "bookkeeping", "trust", "billing", "reports", "tax"];

  for (const dir of pyDirs) {
    const fullDir = join(workspacePath, dir);
    if (!existsSync(fullDir)) continue;

    const files = readdirSync(fullDir).filter(f => f.endsWith(".py") && !f.startsWith("__"));
    for (const file of files) {
      const filePath = join(fullDir, file);
      const content = readFileSync(filePath, "utf-8");
      const name = `${dir}/${file.replace(".py", "")}`;

      const integrations: string[] = [];
      if (content.includes("qbo") || content.includes("quickbooks") || content.includes("QBO")) integrations.push("qbo");
      if (content.includes("stripe") || content.includes("Stripe")) integrations.push("stripe");
      if (content.includes("paperless")) integrations.push("paperless");
      if (content.includes("playwright") || content.includes("td_csv") || content.includes("EasyWeb")) integrations.push("playwright");
      if (content.includes("telegram")) integrations.push("telegram");
      if (content.includes("tailfire")) integrations.push("tailfire");

      let riskTier = 2;
      if (integrations.includes("qbo")) riskTier = 4;
      if (integrations.includes("stripe")) riskTier = 4;
      if (content.includes("trust") || content.includes("Trust")) riskTier = 5;
      if (dir === "reports" || dir === "tax") riskTier = Math.max(riskTier, 3);

      const crossWorkspaceDeps: string[] = [];
      if (content.includes("Phoenix-Voyages") || content.includes("trigger-dev")) crossWorkspaceDeps.push("phoenix-voyages");

      flows.push({
        name, source: "python-script", file: filePath,
        triggerType: "cron", description: `Python script: ${name}`,
        integrations, hasWaitpoints: false, hasApprovalGate: false,
        riskTier, crossWorkspaceDeps,
      });
    }
  }

  return flows;
}

function discoverCronJobs(): DiscoveredFlow[] {
  const crontab = exec("crontab -l 2>/dev/null");
  if (!crontab) return [];

  const flows: DiscoveredFlow[] = [];
  const lines = crontab.split("\n").filter(l => l.trim() && !l.startsWith("#"));

  for (const line of lines) {
    const match = line.match(/^([\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+\s+[\d*\/,\-]+)\s+(.+)$/);
    if (!match) continue;
    const [, schedule, command] = match;

    flows.push({
      name: `cron: ${command!.slice(0, 50)}`,
      source: "cron",
      file: "crontab",
      schedule,
      triggerType: "cron",
      description: `Cron job: ${command}`,
      integrations: [],
      hasWaitpoints: false,
      hasApprovalGate: false,
      riskTier: 2,
      crossWorkspaceDeps: [],
    });
  }

  return flows;
}

function generateMigrationPlan(result: OnboardResult): string {
  const lines: string[] = [];

  lines.push(`# Migration Plan — ${result.workspaceId}`);
  lines.push(`\n**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Workspace:** ${result.workspacePath}`);
  lines.push(`**Flows discovered:** ${result.flows.length}`);
  lines.push(`**Sources:** ${[...new Set(result.flows.map(f => f.source))].join(", ")}`);
  lines.push("");

  // Cross-workspace relationships
  if (result.crossWorkspaceRelationships.length > 0) {
    lines.push("## Cross-Workspace Dependencies");
    lines.push("");
    for (const rel of result.crossWorkspaceRelationships) {
      lines.push(`- **${rel.from}** → **${rel.to}** (via ${rel.via})`);
    }
    lines.push("");
    lines.push("These relationships will become cross-workspace event triggers in Nexaas.");
    lines.push("The target workspace must be onboarded before these flows can be fully migrated.");
    lines.push("");
  }

  // Migration order by risk tier
  lines.push("## Migration Order");
  lines.push("");
  lines.push("| # | Flow | Source | Risk | Schedule | Integrations | Shadow? |");
  lines.push("|---|------|--------|------|----------|--------------|---------|");

  const tierLabels: Record<number, string> = {
    1: "Tier 1 (zero-risk)",
    2: "Tier 2 (low-risk)",
    3: "Tier 3 (medium-risk)",
    4: "Tier 4 (high-risk)",
    5: "Tier 5 (critical)",
  };

  result.migrationOrder.forEach((flow, i) => {
    const shadow = flow.riskTier >= 4 ? "YES" : flow.riskTier >= 3 ? "recommended" : "no";
    const integ = flow.integrations.join(", ") || "none";
    lines.push(`| ${i + 1} | ${flow.name} | ${flow.source} | ${tierLabels[flow.riskTier]} | ${flow.schedule ?? "—"} | ${integ} | ${shadow} |`);
  });

  // Per-flow details
  lines.push("");
  lines.push("## Flow Details");
  lines.push("");

  for (const flow of result.migrationOrder) {
    lines.push(`### ${flow.name}`);
    lines.push("");
    lines.push(`- **Source:** ${flow.source} (${flow.file})`);
    lines.push(`- **Trigger:** ${flow.triggerType}${flow.schedule ? ` (${flow.schedule})` : ""}`);
    lines.push(`- **Description:** ${flow.description}`);
    lines.push(`- **Integrations:** ${flow.integrations.join(", ") || "none"}`);
    lines.push(`- **Risk tier:** ${flow.riskTier} — ${tierLabels[flow.riskTier]}`);
    lines.push(`- **Waitpoints:** ${flow.hasWaitpoints ? "yes" : "no"}`);
    lines.push(`- **Approval gates:** ${flow.hasApprovalGate ? "yes" : "no"}`);
    lines.push(`- **Shadow mode:** ${flow.riskTier >= 4 ? "REQUIRED" : flow.riskTier >= 3 ? "recommended" : "not needed"}`);
    if (flow.crossWorkspaceDeps.length > 0) {
      lines.push(`- **Cross-workspace dependencies:** ${flow.crossWorkspaceDeps.join(", ")}`);
    }
    lines.push(`- **Migration checklist:**`);
    lines.push(`  - [ ] Write Nexaas skill manifest (skill.yaml)`);
    lines.push(`  - [ ] Write prompt (prompt.md)`);
    lines.push(`  - [ ] Disable source flow`);
    lines.push(`  - [ ] Enable Nexaas skill`);
    if (flow.riskTier >= 3) lines.push(`  - [ ] Run shadow mode comparison`);
    lines.push(`  - [ ] Monitor for 1 full business cycle`);
    lines.push(`  - [ ] Verify WAL entries`);
    lines.push(`  - [ ] Mark as migrated`);
    lines.push("");
  }

  return lines.join("\n");
}

function generateClaudeMdAddendum(result: OnboardResult): string {
  return `
## Nexaas Framework (Transitional)

> **This workspace is being migrated to the Nexaas framework.**
> Both Nexaas and the existing automation system run side by side during migration.
> - **New automations** → build as Nexaas skills
> - **Existing automations** → maintain in their current system until migrated
> - **Migration status** → see MIGRATION.md in this workspace

### Nexaas Commands

\`\`\`bash
nexaas status              # Check Nexaas health
nexaas verify-wal          # Verify WAL chain integrity
\`\`\`

### Nexaas Architecture

- **Pillar Pipeline:** Every skill runs through CAG → RAG → Model → TAG → Engine
- **Palace:** All state lives as drawers (structured memory records) in rooms
- **TAG:** Post-model policy enforcement — auto_execute, approval_required, escalate, flag, defer
- **BullMQ:** Job scheduling and execution (replaces Trigger.dev)
- **Bull Board:** Queue dashboard at http://localhost:9090/queues

### Cross-Workspace Awareness

This workspace is registered as \`${result.workspaceId}\` in the Nexaas palace.
${result.crossWorkspaceRelationships.length > 0
    ? `Cross-workspace relationships:\n${result.crossWorkspaceRelationships.map(r => `- ${r.from} → ${r.to} (${r.via})`).join("\n")}`
    : "No cross-workspace dependencies detected."
  }

### Workspace Registration

- **Workspace ID:** ${result.workspaceId}
- **Palace DB:** nexaas_palace (PostgreSQL)
- **Flows discovered:** ${result.flows.length}
- **Migration plan:** MIGRATION.md
`;
}

export async function run(args: string[]) {
  let workspacePath = "";
  let workspaceId = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) { workspacePath = args[i + 1]!; i++; }
    if (args[i] === "--id" && args[i + 1]) { workspaceId = args[i + 1]!; i++; }
  }

  if (!workspacePath) {
    console.error("Usage: nexaas onboard --workspace <path> --id <workspace-id>");
    process.exit(1);
  }

  if (!existsSync(workspacePath)) {
    console.error(`Workspace path not found: ${workspacePath}`);
    process.exit(1);
  }

  if (!workspaceId) {
    workspaceId = basename(workspacePath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }

  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║       Nexaas Workspace Onboarding        ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`  Workspace: ${workspaceId}`);
  console.log(`  Path:      ${workspacePath}\n`);

  // ── Step 1: Discover ──────────────────────────────────────────────

  console.log("[1/5] Discovering automation flows...\n");

  const allFlows: DiscoveredFlow[] = [];

  // Trigger.dev tasks
  const triggerFlows = discoverTriggerDevTasks(workspacePath);
  if (triggerFlows.length > 0) {
    console.log(`  ✓ Found ${triggerFlows.length} Trigger.dev tasks`);
    allFlows.push(...triggerFlows);
  }

  // Python scripts
  const pythonFlows = discoverPythonScripts(workspacePath);
  if (pythonFlows.length > 0) {
    console.log(`  ✓ Found ${pythonFlows.length} Python scripts`);
    allFlows.push(...pythonFlows);
  }

  // Cron jobs
  const cronFlows = discoverCronJobs();
  if (cronFlows.length > 0) {
    console.log(`  ✓ Found ${cronFlows.length} cron jobs`);
    allFlows.push(...cronFlows);
  }

  if (allFlows.length === 0) {
    console.log("  ⚠ No automation flows discovered in this workspace.");
    console.log("  This workspace will be registered for new Nexaas skills.\n");
  }

  // ── Step 2: Detect cross-workspace dependencies ────────────────────

  console.log("\n[2/5] Detecting cross-workspace dependencies...\n");

  const crossWorkspaceRelationships: Array<{ from: string; to: string; via: string }> = [];

  for (const flow of allFlows) {
    for (const dep of flow.crossWorkspaceDeps) {
      crossWorkspaceRelationships.push({
        from: workspaceId,
        to: dep,
        via: flow.name,
      });
    }
  }

  if (crossWorkspaceRelationships.length > 0) {
    for (const rel of crossWorkspaceRelationships) {
      console.log(`  ↔ ${rel.from} → ${rel.to} (via ${rel.via})`);
    }
  } else {
    console.log("  ✓ No cross-workspace dependencies detected");
  }

  // ── Step 3: Classify and order ────────────────────────────────────

  console.log("\n[3/5] Classifying risk tiers and ordering migration...\n");

  const migrationOrder = [...allFlows].sort((a, b) => {
    if (a.riskTier !== b.riskTier) return a.riskTier - b.riskTier;
    if (a.hasWaitpoints !== b.hasWaitpoints) return a.hasWaitpoints ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const tierCounts: Record<number, number> = {};
  for (const flow of migrationOrder) {
    tierCounts[flow.riskTier] = (tierCounts[flow.riskTier] ?? 0) + 1;
  }
  for (const [tier, count] of Object.entries(tierCounts)) {
    console.log(`  Tier ${tier}: ${count} flows`);
  }

  // ── Step 4: Generate migration plan ───────────────────────────────

  console.log("\n[4/5] Generating migration plan...\n");

  const result: OnboardResult = {
    workspaceId,
    workspacePath,
    flows: allFlows,
    crossWorkspaceRelationships,
    migrationOrder,
  };

  const migrationPlan = generateMigrationPlan(result);
  const migrationPath = join(workspacePath, "MIGRATION.md");
  writeFileSync(migrationPath, migrationPlan);
  console.log(`  ✓ Migration plan written to ${migrationPath}`);

  // ── Step 5: Update CLAUDE.md ──────────────────────────────────────

  console.log("\n[5/5] Updating CLAUDE.md...\n");

  const claudeMdPath = join(workspacePath, "CLAUDE.md");
  const addendum = generateClaudeMdAddendum(result);

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8");
    if (existing.includes("## Nexaas Framework")) {
      console.log("  ⚠ CLAUDE.md already has a Nexaas section — skipping update");
    } else {
      writeFileSync(claudeMdPath, existing + "\n" + addendum);
      console.log(`  ✓ Nexaas section appended to ${claudeMdPath}`);
    }
  } else {
    writeFileSync(claudeMdPath, addendum);
    console.log(`  ✓ CLAUDE.md created at ${claudeMdPath}`);
  }

  // ── Register workspace in palace ──────────────────────────────────

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const genesisCheck = exec(`psql "${dbUrl}" -c "SELECT count(*) FROM nexaas_memory.wal WHERE workspace = '${workspaceId}' AND op = 'workspace_genesis'" -t -A 2>/dev/null`);
    if (genesisCheck === "0") {
      exec(`psql "${dbUrl}" -c "INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash) VALUES ('${workspaceId}', 'workspace_genesis', 'system', '{\"workspace\": \"${workspaceId}\", \"path\": \"${workspacePath}\"}', '0000000000000000000000000000000000000000000000000000000000000000', encode(digest('genesis-${workspaceId}', 'sha256'), 'hex'))"`);
      console.log(`  ✓ Workspace '${workspaceId}' registered in palace`);
    } else {
      console.log(`  ✓ Workspace '${workspaceId}' already registered in palace`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────

  console.log(`
╔══════════════════════════════════════════╗
║       Onboarding Complete                ║
╚══════════════════════════════════════════╝

  Workspace:   ${workspaceId}
  Path:        ${workspacePath}
  Flows:       ${allFlows.length} discovered
  Sources:     ${[...new Set(allFlows.map(f => f.source))].join(", ") || "none"}
  Cross-deps:  ${crossWorkspaceRelationships.length} relationships
  Migration:   ${migrationPath}

  Risk distribution:
${Object.entries(tierCounts).map(([t, c]) => `    Tier ${t}: ${c} flows`).join("\n") || "    No flows to migrate"}

  Next steps:
    1. Review MIGRATION.md
    2. Start migrating Tier 1 flows: nexaas migrate-flow <name>
    3. Monitor: nexaas status
`);
}
