import { getSkillPackage, updateSkillFile, gitCommitSkill } from "@/lib/skill-packages";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  const skillId = id.replace("--", "/");

  try {
    const pkg = await getSkillPackage(skillId);
    const content = pkg.fileContents[file];
    if (!content) return notFound("File");
    return ok({ file, content });
  } catch (e) {
    return err(`Failed to read file: ${(e as Error).message}`, 500);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; file: string }> }
) {
  const { id, file } = await params;
  const skillId = id.replace("--", "/");
  const { content } = await request.json();

  if (typeof content !== "string") {
    return err("content must be a string");
  }

  try {
    await updateSkillFile(skillId, file, content);
    const commitOutput = await gitCommitSkill(skillId, file);
    return ok({ message: `Updated ${file}`, commitOutput });
  } catch (e) {
    return err(`Failed to update file: ${(e as Error).message}`, 500);
  }
}
