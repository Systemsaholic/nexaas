import { gitLog } from "@/lib/git";
import { ok, err } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const [category, name] = skillId.split("/");
  const path = `skills/${category}/${name}`;

  try {
    const log = await gitLog(path);
    return ok(log);
  } catch (e) {
    return err(`Failed to get history: ${(e as Error).message}`, 500);
  }
}
