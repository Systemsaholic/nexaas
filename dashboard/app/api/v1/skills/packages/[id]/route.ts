import { getSkillPackage } from "@/lib/skill-packages";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // URL-encode uses -- for / in skill IDs (e.g., msp--email-triage)
  const skillId = id.replace("--", "/");

  try {
    const pkg = await getSkillPackage(skillId);
    return ok(pkg);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Skill package");
    return err(`Failed to load skill: ${msg}`, 500);
  }
}
