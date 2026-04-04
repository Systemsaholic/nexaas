import Anthropic from "@anthropic-ai/sdk";
import { getSkillPackage } from "@/lib/skill-packages";
import { ok, err } from "@/lib/api-response";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are the Nexaas Skill Copilot — an expert at designing autonomous AI skill packages.

You help operators create and improve skills within the Nexaas/Nexmatic platform. Every skill has these files:

1. **contract.yaml** — What the skill needs, produces, locks. Defines execution type (simple/agentic), required integrations, client config fields, approval gates, CAG context reads, RAG namespaces, TAG route defaults.

2. **onboarding-questions.yaml** — Plain-language questions asked during client onboarding. Each answer maps to exactly one config field. Options over freetext where possible.

3. **system-prompt.hbs** — Handlebars template with {{slots}} filled by CAG at runtime. Includes behavioral contract, sender context, RAG chunks, platform rules, response format, and self-reflection protocol.

4. **tag-routes.yaml** — How Claude's output gets routed: auto_execute, notify_after, approval_required, escalate, flag, defer. Each route has conditions and actions.

5. **rag-config.yaml** — Retrieval namespace strategy: primary (tenant), skill_docs, fallback (global). Cascade search with relevance threshold.

Key principles:
- Skills are CLIENT-AGNOSTIC. No client-specific logic. All customization via onboarding config.
- Skills are either "simple" (single API call) or "agentic" (multi-step with MCP tool use).
- platform_locked fields cannot be overridden by clients.
- Every prompt must include the Self-Reflection Protocol (SKILL_IMPROVEMENT_CANDIDATE).
- Approval gates have a platform floor — clients can tighten but never loosen.
- TAG never makes business decisions — it only enforces contract rules.

When generating or modifying files, output the COMPLETE file content ready to save. Use proper YAML/Handlebars syntax.`;

export async function POST(request: Request) {
  const { message, skillId, activeFile, fileContent } = await request.json();

  if (!message) return err("message is required");

  try {
    // Build context from current skill if editing
    let context = "";
    if (skillId) {
      try {
        const pkg = await getSkillPackage(skillId);
        context = `\n\nCurrent skill: ${skillId} (${pkg.type})\nFiles: ${pkg.files.join(", ")}\n`;

        if (activeFile && pkg.fileContents[activeFile]) {
          context += `\nCurrently editing: ${activeFile}\n\`\`\`\n${pkg.fileContents[activeFile]}\n\`\`\`\n`;
        }

        // Include contract for context regardless
        if (activeFile !== "contract.yaml" && pkg.fileContents["contract.yaml"]) {
          context += `\nSkill contract:\n\`\`\`yaml\n${pkg.fileContents["contract.yaml"]}\n\`\`\`\n`;
        }
      } catch { /* skill may not exist yet */ }
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `${context}\n\nOperator request: ${message}`,
        },
      ],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    return ok({
      response: text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        model: response.model,
      },
    });
  } catch (e) {
    return err(`Copilot error: ${(e as Error).message}`, 500);
  }
}
