/**
 * nexaas migrate-flow — interactive flow migration assistant.
 *
 * Scans the workspace for automation flows, presents them with risk tiers,
 * and walks the operator through converting each one to a Nexaas skill.
 *
 * Usage:
 *   nexaas migrate-flow                    Interactive — pick from discovered flows
 *   nexaas migrate-flow --skill-id <id>    Migrate a specific flow by ID
 *   nexaas migrate-flow --list             List all flows with migration status
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { createInterface } from "readline";

function exec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim(); } catch { return ""; }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ? ${question}: `, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

interface SkillEntry {
  id: string;
  version: string;
  description: string;
  type: string;
  schedule?: string;
  path: string;
}

function discoverRegisteredSkills(skillsRoot: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  if (!existsSync(skillsRoot)) return skills;

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else if (entry.name === "skill.yaml") {
        try {
          const content = readFileSync(join(dir, entry.name), "utf-8");
          const idMatch = content.match(/^id:\s*(.+)/m);
          const versionMatch = content.match(/^version:\s*(.+)/m);
          const descMatch = content.match(/^description:\s*(.+)/m);
          const typeMatch = content.match(/type:\s*(shell|ai-skill)/m);
          const schedMatch = content.match(/schedule:\s*"(.+)"/m);

          if (idMatch) {
            skills.push({
              id: idMatch[1]!.trim(),
              version: versionMatch?.[1]?.trim() ?? "0.0.0",
              description: descMatch?.[1]?.trim() ?? "",
              type: typeMatch?.[1]?.trim() ?? "unknown",
              schedule: schedMatch?.[1]?.trim(),
              path: join(dir, entry.name),
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(skillsRoot);
  return skills;
}

function discoverTriggerDevSchedules(): Array<{ id: string; active: boolean }> {
  const result = exec(
    `docker exec trigger-postgres psql -U postgres -d trigger -c "SELECT \\\"taskIdentifier\\\", active FROM \\\"TaskSchedule\\\" ORDER BY \\\"taskIdentifier\\\"" -t -A 2>/dev/null`,
  );

  if (!result) return [];

  return result.split("\n").filter(Boolean).map((line) => {
    const [id, active] = line.split("|");
    return { id: id!.trim(), active: active === "t" };
  });
}

export async function run(args: string[]) {
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";

  if (args.includes("--list")) {
    console.log("\n  Nexaas Migration Status\n");

    // Discover registered skills
    const skillsRoot = join(workspaceRoot, "nexaas-skills");
    const skills = discoverRegisteredSkills(skillsRoot);

    // Discover Trigger.dev schedules
    const triggerSchedules = discoverTriggerDevSchedules();

    console.log("  Nexaas Skills (registered):");
    if (skills.length === 0) {
      console.log("    (none)\n");
    } else {
      for (const s of skills) {
        const typeIcon = s.type === "ai-skill" ? "🤖" : "⚙️";
        console.log(`    ${typeIcon} ${s.id} v${s.version} — ${s.description}`);
      }
      console.log("");
    }

    console.log("  Trigger.dev Schedules:");
    const activeSchedules = triggerSchedules.filter((s) => s.active);
    const disabledSchedules = triggerSchedules.filter((s) => !s.active);

    if (activeSchedules.length > 0) {
      console.log(`    Still active (${activeSchedules.length}):`);
      for (const s of activeSchedules) {
        console.log(`      ⚠ ${s.id}`);
      }
    } else {
      console.log("    ✓ All disabled — fully migrated to Nexaas");
    }

    if (disabledSchedules.length > 0) {
      console.log(`    Disabled (${disabledSchedules.length}):`);
      for (const s of disabledSchedules) {
        console.log(`      ✓ ${s.id} (migrated)`);
      }
    }

    // Recent run stats
    const stats = exec(
      `psql "${dbUrl}" -c "SELECT skill_id, status, count(*) FROM nexaas_memory.skill_runs GROUP BY skill_id, status ORDER BY skill_id" -t -A 2>/dev/null`,
    );

    if (stats) {
      console.log("\n  Run Statistics:");
      const lines = stats.split("\n").filter(Boolean);
      const bySkill = new Map<string, { completed: number; failed: number; running: number }>();

      for (const line of lines) {
        const [skillId, status, count] = line.split("|");
        if (!skillId) continue;
        if (!bySkill.has(skillId)) bySkill.set(skillId, { completed: 0, failed: 0, running: 0 });
        const entry = bySkill.get(skillId)!;
        if (status === "completed") entry.completed = parseInt(count!, 10);
        else if (status === "failed") entry.failed = parseInt(count!, 10);
        else if (status === "running") entry.running = parseInt(count!, 10);
      }

      for (const [id, counts] of bySkill) {
        const total = counts.completed + counts.failed;
        const rate = total > 0 ? Math.round((counts.completed / total) * 100) : 0;
        const icon = rate >= 95 ? "✓" : rate >= 50 ? "⚠" : "✗";
        console.log(`    ${icon} ${id}: ${counts.completed} ok, ${counts.failed} fail (${rate}%)`);
      }
    }

    console.log("");
    return;
  }

  // Interactive mode
  console.log("\n  Use 'nexaas migrate-flow --list' to see migration status.");
  console.log("  Use Claude Code with /migrate-flow for the full interactive migration experience.\n");
}
