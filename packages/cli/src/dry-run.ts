/**
 * nexaas dry-run — test a skill locally without scheduling.
 *
 * Loads the manifest, validates it, optionally runs the skill once,
 * and reports results. For AI skills, shows what would happen without
 * calling the model (unless --live is passed).
 *
 * Usage:
 *   nexaas dry-run <path-to-skill.yaml>           Validate and show execution plan
 *   nexaas dry-run <path-to-skill.yaml> --live     Actually execute the skill once
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { load as yamlLoad } from "js-yaml";
import pg from "pg";

interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  timezone?: string;
  triggers?: Array<{ type: string; schedule?: string; timezone?: string }>;
  execution?: { type: string; command?: string; timeout?: number; model_tier?: string; working_directory?: string };
  mcp_servers?: string[];
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
    retrieval_rooms?: Array<{ wing: string; hall: string; room: string }>;
  };
  outputs?: Array<{ id: string; routing_default?: string; overridable?: boolean }>;
  self_reflection?: boolean;
}

export async function run(args: string[]) {
  const manifestPath = args.find(a => !a.startsWith("--"));
  const isLive = args.includes("--live");

  if (!manifestPath) {
    console.log(`
  nexaas dry-run — test a skill locally

  Usage:
    nexaas dry-run <path-to-skill.yaml>         Validate and show execution plan
    nexaas dry-run <path-to-skill.yaml> --live   Execute the skill once (real run)
`);
    return;
  }

  if (!existsSync(manifestPath)) {
    console.error(`File not found: ${manifestPath}`);
    process.exit(1);
  }

  const content = readFileSync(manifestPath, "utf-8");
  let manifest: SkillManifest;
  try {
    manifest = yamlLoad(content) as SkillManifest;
  } catch (e) {
    console.error(`Invalid YAML: ${(e as Error).message}`);
    process.exit(1);
  }

  const skillDir = dirname(manifestPath);
  const issues: string[] = [];
  const warnings: string[] = [];

  console.log("\n  Nexaas Dry Run\n");
  console.log(`  Skill: ${manifest.id ?? "(no id)"}`);
  console.log(`  Version: ${manifest.version ?? "(no version)"}`);
  console.log(`  Type: ${manifest.execution?.type ?? "(no execution type)"}`);
  console.log(`  Description: ${manifest.description ?? "(none)"}`);
  console.log("");

  // Validation
  if (!manifest.id) issues.push("Missing 'id' field");
  if (!manifest.version) issues.push("Missing 'version' field");
  if (!manifest.execution?.type) issues.push("Missing 'execution.type' field");

  if (manifest.execution?.type === "ai-skill") {
    const promptPath = join(skillDir, "prompt.md");
    if (!existsSync(promptPath)) {
      issues.push("Missing prompt.md (required for AI skills)");
    } else {
      const prompt = readFileSync(promptPath, "utf-8");
      console.log(`  Prompt: ${prompt.length} chars (${promptPath})`);

      if (!prompt.includes("SKILL_IMPROVEMENT_CANDIDATE")) {
        warnings.push("prompt.md missing Self-Reflection Protocol (SKILL_IMPROVEMENT_CANDIDATE marker)");
      }
    }

    if (!manifest.execution.model_tier) {
      warnings.push("No model_tier specified — will default to 'good' (Sonnet)");
    } else {
      const validTiers = ["cheap", "good", "better", "best"];
      if (!validTiers.includes(manifest.execution.model_tier)) {
        issues.push(`Invalid model_tier '${manifest.execution.model_tier}' — must be: ${validTiers.join(", ")}`);
      }
      console.log(`  Model tier: ${manifest.execution.model_tier}`);
    }

    if (manifest.mcp_servers && manifest.mcp_servers.length > 0) {
      console.log(`  MCP servers: ${manifest.mcp_servers.join(", ")}`);

      const wsRoot = process.env.NEXAAS_WORKSPACE_ROOT;
      if (wsRoot) {
        const mcpConfigPath = join(wsRoot, ".mcp.json");
        if (existsSync(mcpConfigPath)) {
          try {
            const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
            const mcpServers = mcpConfig.mcpServers ?? mcpConfig;
            for (const server of manifest.mcp_servers) {
              if (!mcpServers[server]) {
                issues.push(`MCP server '${server}' not found in ${mcpConfigPath}`);
              }
            }
          } catch {
            warnings.push(`Could not parse ${mcpConfigPath}`);
          }
        } else {
          warnings.push(`No .mcp.json found at ${mcpConfigPath}`);
        }
      }
    } else {
      warnings.push("No MCP servers declared — Claude will have no tools");
    }
  }

  if (manifest.execution?.type === "shell") {
    if (!manifest.execution.command) {
      issues.push("Shell skill missing 'execution.command'");
    } else {
      console.log(`  Command: ${manifest.execution.command}`);
    }
    if (manifest.execution.model_tier) {
      warnings.push("Shell skills ignore model_tier — remove it or switch to ai-skill");
    }
  }

  // Triggers
  if (manifest.triggers && manifest.triggers.length > 0) {
    console.log(`  Triggers: ${manifest.triggers.length}`);
    for (const t of manifest.triggers) {
      const tz = t.timezone ?? manifest.timezone ?? "UTC";
      console.log(`    - ${t.type}: ${t.schedule ?? "(no schedule)"} (${tz})`);
    }
  } else {
    warnings.push("No triggers defined — skill can only be triggered manually");
  }

  // Palace rooms
  if (manifest.rooms?.primary) {
    const p = manifest.rooms.primary;
    console.log(`  Primary room: ${p.wing}/${p.hall}/${p.room}`);
  }
  if (manifest.rooms?.retrieval_rooms && manifest.rooms.retrieval_rooms.length > 0) {
    console.log(`  Retrieval rooms: ${manifest.rooms.retrieval_rooms.length}`);
    for (const r of manifest.rooms.retrieval_rooms) {
      console.log(`    - ${r.wing}/${r.hall}/${r.room}`);
    }
  }

  // TAG outputs
  if (manifest.outputs && manifest.outputs.length > 0) {
    console.log(`  Outputs: ${manifest.outputs.length}`);
    for (const o of manifest.outputs) {
      console.log(`    - ${o.id}: ${o.routing_default ?? "auto_execute"} (overridable: ${o.overridable ?? true})`);
    }
  }

  // Fixtures
  const fixturesDir = join(skillDir, "fixtures");
  if (existsSync(fixturesDir)) {
    console.log(`  Fixtures: ${fixturesDir}`);
  }

  // Report
  console.log("");
  if (issues.length > 0) {
    console.log("  Issues (must fix):");
    for (const i of issues) console.log(`    !! ${i}`);
  }
  if (warnings.length > 0) {
    console.log("  Warnings:");
    for (const w of warnings) console.log(`     ! ${w}`);
  }
  if (issues.length === 0 && warnings.length === 0) {
    console.log("  Validation: PASS");
  }

  if (issues.length > 0) {
    console.log(`\n  Result: FAILED (${issues.length} issue(s))\n`);
    process.exit(1);
  }

  if (!isLive) {
    console.log(`\n  Result: VALID — run with --live to execute\n`);
    return;
  }

  // Live execution
  console.log("\n  Executing skill...\n");

  const workspace = process.env.NEXAAS_WORKSPACE;
  const dbUrl = process.env.DATABASE_URL;

  if (!workspace || !dbUrl) {
    console.error("  NEXAAS_WORKSPACE and DATABASE_URL required for --live");
    process.exit(1);
  }

  if (manifest.execution?.type === "shell") {
    const { execSync } = await import("child_process");
    const cwd = manifest.execution.working_directory ?? skillDir;
    const timeout = (manifest.execution.timeout ?? 120) * 1000;

    try {
      const output = execSync(manifest.execution.command!, {
        encoding: "utf-8",
        cwd,
        timeout,
        stdio: "pipe",
        env: { ...process.env },
      });
      console.log("  Output:");
      for (const line of output.split("\n")) console.log(`    ${line}`);
      console.log(`\n  Result: SUCCESS\n`);
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      console.error(`  Error: ${err.stderr ?? err.message}`);
      console.log(`\n  Result: FAILED\n`);
      process.exit(1);
    }
  } else if (manifest.execution?.type === "ai-skill") {
    console.log("  AI skill dry-run with --live triggers a real agentic loop.");
    console.log("  Use: nexaas trigger-skill " + manifestPath);
    console.log(`\n  Result: SKIPPED (use trigger-skill for live AI runs)\n`);
  }
}
