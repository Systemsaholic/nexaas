import { query } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const { id, skillId } = await params;
  const skill = skillId.replace("--", "/");
  const { active } = await request.json();

  try {
    await query(
      `UPDATE workspace_skills SET active = $1 WHERE workspace_id = $2 AND skill_id = $3`,
      [active ?? true, id, skill]
    );

    return ok({ message: `${skill} ${active ? "activated" : "deactivated"} on ${id}` });
  } catch (e) {
    return err(`Failed to update skill status: ${(e as Error).message}`, 500);
  }
}
