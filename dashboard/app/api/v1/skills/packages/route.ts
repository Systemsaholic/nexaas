import { listSkillPackages } from "@/lib/skill-packages";
import { ok, err } from "@/lib/api-response";

export async function GET() {
  try {
    const packages = await listSkillPackages();
    return ok(packages);
  } catch (e) {
    return err(`Failed to list skill packages: ${(e as Error).message}`, 500);
  }
}
