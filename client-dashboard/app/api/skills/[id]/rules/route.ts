import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

function getRulesPath(skillId: string): string {
  const [category, name] = skillId.split("/");
  return join(NEXAAS_ROOT, "config", category, name, "rules.yaml");
}

// GET: Load current custom rules
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");

  try {
    const raw = await readFile(getRulesPath(skillId), "utf-8");
    return NextResponse.json({ ok: true, data: { rules: raw } });
  } catch {
    return NextResponse.json({ ok: true, data: { rules: "# No custom rules yet\nrules: []\n" } });
  }
}

// POST: AI-powered rule creation from natural language
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const { message, confirm } = await request.json();

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Load existing rules
  let existingRules = "rules: []\n";
  try {
    existingRules = await readFile(getRulesPath(skillId), "utf-8");
  } catch { /* no rules yet */ }

  // Load skill contract for context
  let contractContext = "";
  try {
    const [category, name] = skillId.split("/");
    contractContext = await readFile(join(NEXAAS_ROOT, "skills", category, name, "contract.yaml"), "utf-8");
  } catch { /* skip */ }

  if (confirm) {
    // Client confirmed the proposed rule — write it
    try {
      const [category, name] = skillId.split("/");
      await mkdir(join(NEXAAS_ROOT, "config", category, name), { recursive: true });
      await writeFile(getRulesPath(skillId), confirm, "utf-8");
      return NextResponse.json({ ok: true, message: "Rule applied!" });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  // AI parses the natural language request into a YAML rule
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `You help clients customize their AI skill behavior by creating rules.

The client is modifying rules for the "${skillId}" skill.

Current rules file:
\`\`\`yaml
${existingRules}
\`\`\`

${contractContext ? `Skill contract:\n\`\`\`yaml\n${contractContext}\n\`\`\`` : ""}

When the client describes what they want, you must:
1. Explain in plain language what the rule will do (1-2 sentences)
2. Output the COMPLETE updated rules.yaml file (not just the new rule)

Rules format:
\`\`\`yaml
rules:
  - id: unique-kebab-id
    description: "What this rule does in plain language"
    condition: "When this matches"
    action: "Do this"
    priority: 10
\`\`\`

ALWAYS output the complete file with all existing rules preserved plus the new one.`,
      messages: [{ role: "user", content: message }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    // Extract the YAML block
    const yamlMatch = text.match(/```yaml\n([\s\S]*?)```/);
    const proposedRules = yamlMatch ? yamlMatch[1].trim() : null;

    // Extract the explanation (text before code block)
    const explanation = text.split("```")[0].trim();

    return NextResponse.json({
      ok: true,
      data: {
        explanation,
        proposedRules,
        rawResponse: text,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
