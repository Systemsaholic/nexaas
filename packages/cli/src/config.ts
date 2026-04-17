/**
 * nexaas config — view and set workspace configuration.
 *
 * Usage:
 *   nexaas config                          Show current config
 *   nexaas config set timezone America/Toronto
 *   nexaas config set default-model-tier good
 *   nexaas config set display-name "Phoenix Voyages"
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
      console.error(`  Valid keys: timezone, default-model-tier, display-name, workspace-root`);
      process.exit(1);
    }

    exec(`psql "${dbUrl}" -c "UPDATE nexaas_memory.workspace_config SET ${column} = '${value}', updated_at = now() WHERE workspace = '${workspace}'" 2>/dev/null`);
    console.log(`\n  ✓ ${key} = ${value}\n`);
    return;
  }

  // Show current config
  const row = exec(`psql "${dbUrl}" -c "SELECT timezone, display_name, default_model_tier, workspace_root, created_at::text, updated_at::text FROM nexaas_memory.workspace_config WHERE workspace = '${workspace}'" -t -A 2>/dev/null`);

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
  console.log(`  Created:            ${parts[4]}`);
  console.log(`  Updated:            ${parts[5]}`);
  console.log("");
}
