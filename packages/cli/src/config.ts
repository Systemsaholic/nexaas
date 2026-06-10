/**
 * nexaas config — view and set workspace configuration.
 *
 * Usage:
 *   nexaas config                          Show current config
 *   nexaas config set timezone America/Toronto
 *   nexaas config set default-model-tier good
 *   nexaas config set display-name "Phoenix Voyages"
 *   nexaas config set spend-budget 25     Daily AI budget in USD (#215); "off" = unlimited
 *   nexaas config set spend-override today   Disable budget enforcement for today only
 */

import { execSync } from "child_process";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

export async function run(args: string[]) {
  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL are required");
    process.exit(1);
  }

  // Ensure config row exists
  exec(`psql "${dbUrl}" -c "INSERT INTO nexaas_memory.workspace_config (workspace) VALUES ('${workspace}') ON CONFLICT DO NOTHING" 2>/dev/null`);

  if (args[0] === "set" && args[1] && args[2]) {
    const key = args[1];
    const value = args.slice(2).join(" ");

    // Daily spend budget (#215). Numeric column; "off"/"none" clears it
    // (NULL = unlimited, the default for every existing workspace).
    if (key === "spend-budget") {
      if (value === "off" || value === "none") {
        exec(`psql "${dbUrl}" -c "UPDATE nexaas_memory.workspace_config SET spend_daily_budget_usd = NULL, updated_at = now() WHERE workspace = '${workspace}'" 2>/dev/null`);
        console.log(`\n  ✓ spend-budget = off (unlimited)\n`);
        return;
      }
      const budget = Number(value);
      if (!Number.isFinite(budget) || budget <= 0) {
        console.error(`  spend-budget must be a positive number of USD, or "off"`);
        process.exit(1);
      }
      exec(`psql "${dbUrl}" -c "UPDATE nexaas_memory.workspace_config SET spend_daily_budget_usd = ${budget}, updated_at = now() WHERE workspace = '${workspace}'" 2>/dev/null`);
      console.log(`\n  ✓ spend-budget = $${budget.toFixed(2)}/day\n`);
      return;
    }

    // One-day budget override (#215): "today" resolves to the workspace's
    // local date; an explicit YYYY-MM-DD is accepted for pre-arming. The
    // worker's spend-budget monitor resumes the queue within a minute.
    if (key === "spend-override") {
      let day = value;
      if (value === "today") {
        const tz = exec(`psql "${dbUrl}" -t -A -c "SELECT timezone FROM nexaas_memory.workspace_config WHERE workspace = '${workspace}'" 2>/dev/null`) || "UTC";
        try {
          day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        } catch {
          day = new Date().toISOString().slice(0, 10);
        }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        console.error(`  spend-override takes "today" or a YYYY-MM-DD date`);
        process.exit(1);
      }
      exec(`psql "${dbUrl}" -c "INSERT INTO nexaas_memory.workspace_kv (workspace, key, value) VALUES ('${workspace}', 'spend_budget_override_date', '${day}') ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value" 2>/dev/null`);
      console.log(`\n  ✓ spend-override = ${day} (budget enforcement disabled for that local day)\n`);
      return;
    }

    const columnMap: Record<string, string> = {
      "timezone": "timezone",
      "tz": "timezone",
      "default-model-tier": "default_model_tier",
      "model-tier": "default_model_tier",
      "display-name": "display_name",
      "name": "display_name",
      "workspace-root": "workspace_root",
      "root": "workspace_root",
    };

    const column = columnMap[key];
    if (!column) {
      console.error(`  Unknown config key: ${key}`);
      console.error(`  Valid keys: timezone, default-model-tier, display-name, workspace-root, spend-budget, spend-override`);
      process.exit(1);
    }

    exec(`psql "${dbUrl}" -c "UPDATE nexaas_memory.workspace_config SET ${column} = '${value}', updated_at = now() WHERE workspace = '${workspace}'" 2>/dev/null`);
    console.log(`\n  ✓ ${key} = ${value}\n`);
    return;
  }

  // Show current config
  const row = exec(`psql "${dbUrl}" -c "SELECT timezone, display_name, default_model_tier, workspace_root, created_at::text, updated_at::text FROM nexaas_memory.workspace_config WHERE workspace = '${workspace}'" -t -A 2>/dev/null`);
  // Queried separately: the column arrives with migration 026, and config
  // must keep working against a not-yet-migrated DB (upgrade-window skew).
  const budget = exec(`psql "${dbUrl}" -c "SELECT spend_daily_budget_usd::text FROM nexaas_memory.workspace_config WHERE workspace = '${workspace}'" -t -A 2>/dev/null`);

  if (!row) {
    console.log(`\n  No config found for workspace '${workspace}'. Run 'nexaas config set timezone America/Toronto' to initialize.\n`);
    return;
  }

  const parts = row.split("|");
  console.log(`\n  Nexaas Config — ${workspace}\n`);
  console.log(`  Timezone:           ${parts[0] || "UTC (default)"}`);
  console.log(`  Display name:       ${parts[1] || "(not set)"}`);
  console.log(`  Default model tier: ${parts[2] || "good"}`);
  console.log(`  Workspace root:     ${parts[3] || "(not set)"}`);
  console.log(`  Daily spend budget: ${budget ? `$${Number(budget).toFixed(2)}/day` : "(unlimited)"}`);
  console.log(`  Created:            ${parts[4]}`);
  console.log(`  Updated:            ${parts[5]}`);
  console.log("");
}
