import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

function getConfigPath(skillId: string): string {
  const [category, name] = skillId.split("/");
  return join(NEXAAS_ROOT, "config", category, `${name}.yaml`);
}

// GET: Load current skill-specific config
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");

  try {
    const yaml = await import("js-yaml");
    const raw = await readFile(getConfigPath(skillId), "utf-8");
    const config = yaml.load(raw);

    // Also load onboarding questions to show what can be edited
    const [category, name] = skillId.split("/");
    let questions: any[] = [];
    try {
      const qRaw = await readFile(join(NEXAAS_ROOT, "skills", category, name, "onboarding-questions.yaml"), "utf-8");
      const parsed = yaml.load(qRaw) as { questions: any[] };
      questions = parsed.questions ?? [];
    } catch { /* no questions */ }

    return NextResponse.json({ ok: true, data: { config, questions } });
  } catch {
    return NextResponse.json({ ok: true, data: { config: null, questions: [] } });
  }
}

// PUT: Update skill-specific config
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const { config } = await request.json();

  try {
    const yaml = await import("js-yaml");
    const [category] = skillId.split("/");
    await mkdir(join(NEXAAS_ROOT, "config", category), { recursive: true });
    await writeFile(getConfigPath(skillId), yaml.dump(config, { lineWidth: 120 }), "utf-8");
    return NextResponse.json({ ok: true, message: "Preferences saved" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
