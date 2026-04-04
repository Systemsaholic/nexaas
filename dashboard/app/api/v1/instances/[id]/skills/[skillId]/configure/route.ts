import { loadManifest } from "@/lib/manifests";
import { getSkillPackage } from "@/lib/skill-packages";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";
import YAML from "js-yaml";

// GET: Load onboarding questions + any existing config
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const { id, skillId } = await params;
  const skill = skillId.replace("--", "/");

  try {
    const pkg = await getSkillPackage(skill);
    const questions = pkg.fileContents["onboarding-questions.yaml"];
    if (!questions) return notFound("Onboarding questions");

    const parsed = YAML.load(questions) as { questions: unknown[] };

    // Try to load existing config from instance
    const manifest = await loadManifest(id);
    let existingConfig: Record<string, unknown> | null = null;
    if (manifest.ssh) {
      const [category, name] = skill.split("/");
      const result = await sshExec(manifest, `cat /opt/nexaas/config/${category}/${name}.yaml 2>/dev/null || echo '{}'`);
      try {
        existingConfig = YAML.load(result.stdout) as Record<string, unknown>;
        if (typeof existingConfig !== "object") existingConfig = null;
      } catch { /* no existing config */ }
    }

    return ok({
      questions: parsed.questions,
      existingConfig,
      skill,
      instance: id,
    });
  } catch (e) {
    return err(`Failed to load questions: ${(e as Error).message}`, 500);
  }
}

// POST: Save onboarding answers as config on instance
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const { id, skillId } = await params;
  const skill = skillId.replace("--", "/");
  const { answers } = await request.json();

  if (!answers || typeof answers !== "object") {
    return err("answers object is required");
  }

  try {
    const manifest = await loadManifest(id);
    if (!manifest.ssh) return notFound("SSH config");

    const [category, name] = skill.split("/");

    // Build config from answers using the onboarding questions mapping
    const pkg = await getSkillPackage(skill);
    const questionsRaw = pkg.fileContents["onboarding-questions.yaml"];
    const parsed = YAML.load(questionsRaw ?? "") as { questions: Array<{ id: string; maps_to: string }> };

    const config: Record<string, unknown> = {
      skill: name,
      adapter: answers.adapter ?? "default",
      status: "configured",
    };

    // Map answers to config paths
    for (const q of parsed.questions ?? []) {
      if (answers[q.id] !== undefined) {
        setNestedValue(config, q.maps_to, answers[q.id]);
      }
    }

    const yamlConfig = YAML.dump(config, { lineWidth: 120 });

    // Write config to instance via SSH
    await sshExec(manifest, `mkdir -p /opt/nexaas/config/${category}`, 10000);
    await sshExec(manifest, `cat > /opt/nexaas/config/${category}/${name}.yaml << 'CONFIGEOF'\n${yamlConfig}\nCONFIGEOF`, 10000);

    return ok({ message: `Config saved for ${skill} on ${id}`, config });
  } catch (e) {
    return err(`Failed to save config: ${(e as Error).message}`, 500);
  }
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
