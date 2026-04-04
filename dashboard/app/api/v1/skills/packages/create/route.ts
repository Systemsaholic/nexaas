import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "js-yaml";
import { ok, err } from "@/lib/api-response";

const exec = promisify(execFile);
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export async function POST(request: Request) {
  const { category, name, type, description, adapters, mcpServers } = await request.json();

  if (!category || !name || !type || !description) {
    return err("category, name, type, and description are required");
  }

  const skillId = `${category}/${name}`;
  const skillDir = join(NEXAAS_ROOT, "skills", category, name);

  // Check if already exists
  try {
    await readFile(join(skillDir, "contract.yaml"));
    return err(`Skill ${skillId} already exists`);
  } catch { /* doesn't exist, good */ }

  try {
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(skillDir, "tests"), { recursive: true });

    // Generate contract.yaml
    const contract: Record<string, unknown> = {
      skill: name,
      version: "1.0.0",
      category,
      type,
      description,
      execution: type === "agentic"
        ? { type: "agentic", model: "claude-sonnet-4-20250514", max_tokens: 4000, timeout_seconds: 600, max_tool_calls: 50, concurrency_weight: 2 }
        : { type: "simple", model: "claude-sonnet-4-20250514", max_tokens: 1000, timeout_seconds: 30 },
      adapters: adapters ?? [],
      mcp_servers: mcpServers ?? [],
      requires: {},
      client_must_configure: { required: [], optional: [] },
      platform_locked: {
        always_audit_log: true,
        always_produce_reasoning: true,
      },
      reads_from_context: ["client_profile", "approval_gates", "hard_limits", "workflow_state"],
      rag: {
        primary: "[tenant]_knowledge",
        skill_docs: `skill/${name}-docs`,
        fallback: `global/${category}_policies`,
        limit: 3,
      },
      produces: [],
      tag_defaults: {
        auto_execute: [],
        approval_required: [],
        escalate: [],
        flag: ["hard_limit_triggered", "uncertain"],
      },
      changelog: [{ version: "1.0.0", date: new Date().toISOString().split("T")[0], changes: "Initial skill package" }],
    };
    await writeFile(join(skillDir, "contract.yaml"), YAML.dump(contract, { lineWidth: 120 }));

    // Generate onboarding-questions.yaml
    const onboarding = {
      questions: [
        {
          id: "hard_limits",
          required: true,
          question: "Are there things you'd never want the AI to do or say?",
          type: "freetext",
          examples: ["Never commit to pricing", "Never share confidential info"],
          maps_to: "hard_limits",
        },
      ],
    };
    await writeFile(join(skillDir, "onboarding-questions.yaml"), YAML.dump(onboarding, { lineWidth: 120 }));

    // Generate system-prompt.hbs
    const prompt = `You are the AI assistant for {{tenantName}}.

## Behavioral Contract
Tone: {{tone}} | Domain: {{domain}}
Hard limits: {{#each hardLimits}}- {{this}}
{{/each}}

## Relevant Policies
{{#each ragChunks}}
---
{{this.content}}
{{/each}}

## Platform Rules
- Always produce a reasoning field
- If uncertain → flag for human review, never guess

## Response Format — JSON only
{
  "action": "string",
  "reasoning": "string — always required"
}

## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [one paragraph — generic capability description,
no client names, no specific data, no workspace-specific context]
`;
    await writeFile(join(skillDir, "system-prompt.hbs"), prompt);

    // Generate tag-routes.yaml
    const tagRoutes = {
      routes: {
        auto_execute: { conditions: [], actions: ["execute", "audit_log"] },
        approval_required: { conditions: [], actions: ["send_approval_request", "audit_log"] },
        escalate: { conditions: [], actions: ["forward_to_escalation_target", "audit_log"] },
        flag: { conditions: [{ hard_limit_triggered: true }, { requires_human_review: true }], actions: ["create_review_task", "audit_log"] },
      },
    };
    await writeFile(join(skillDir, "tag-routes.yaml"), YAML.dump(tagRoutes, { lineWidth: 120 }));

    // Generate rag-config.yaml
    const ragConfig = {
      namespaces: {
        primary: "[tenant]_knowledge",
        skill_docs: `skill/${name}`,
        fallback: `global/${category}_policies`,
      },
      retrieval: { strategy: "cascade", limit: 3, min_relevance: 0.7 },
    };
    await writeFile(join(skillDir, "rag-config.yaml"), YAML.dump(ragConfig, { lineWidth: 120 }));

    // Generate CHANGELOG.md
    const changelog = `# ${name} — Changelog\n\n## 1.0.0 (${new Date().toISOString().split("T")[0]})\n- Initial skill package\n`;
    await writeFile(join(skillDir, "CHANGELOG.md"), changelog);

    // Update registry
    const registryPath = join(NEXAAS_ROOT, "skills", "_registry.yaml");
    const registryRaw = await readFile(registryPath, "utf-8");
    const registry = YAML.load(registryRaw) as { version: string; skills: Array<Record<string, unknown>> };

    registry.skills.push({
      id: skillId,
      version: "1.0.0",
      type,
      status: "active",
      description,
      mcp: mcpServers ?? [],
      workspaces: [],
    });

    await writeFile(registryPath, YAML.dump(registry, { lineWidth: 120 }));

    // Git commit
    await exec("git", ["add", `skills/${category}/${name}/`, "skills/_registry.yaml"], { cwd: NEXAAS_ROOT });
    await exec("git", ["-c", "user.name=Nexmatic", "-c", "user.email=ops@nexmatic.com", "commit", "-m", `skill: create ${skillId} v1.0.0`], { cwd: NEXAAS_ROOT });
    await exec("git", ["push"], { cwd: NEXAAS_ROOT });

    return ok({ id: skillId, message: `Created skill package ${skillId}` }, 201);
  } catch (e) {
    return err(`Failed to create skill: ${(e as Error).message}`, 500);
  }
}
