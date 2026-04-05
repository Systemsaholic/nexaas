import { query } from "@/lib/db";
import { loadManifest, saveManifest, rsyncManifestToVps } from "@/lib/manifests";
import { deployMcpServersForSkill, getMcpDefaultPort } from "@/lib/mcp-deploy";
import { ok, err } from "@/lib/api-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const { id, skillId } = await params;
  const skill = skillId.replace("--", "/");
  const { active } = await request.json();

  try {
    // On activate: verify/repair MCP dependencies and manifest
    if (active !== false) {
      const manifest = await loadManifest(id);

      // Deploy any missing MCP servers
      const mcpResult = await deployMcpServersForSkill(manifest, skill);

      // Ensure skill is registered in manifest
      let manifestChanged = false;
      if (!manifest.skills.includes(skill)) {
        manifest.skills.push(skill);
        manifestChanged = true;
      }
      for (const mcpId of mcpResult.deployed) {
        const port = await getMcpDefaultPort(mcpId);
        manifest.mcp[mcpId] = port ? `http://localhost:${port}` : "stdio";
        manifestChanged = true;
      }

      if (manifestChanged && manifest.ssh) {
        await saveManifest(manifest);
        await rsyncManifestToVps(manifest);
      }
    }

    await query(
      `UPDATE workspace_skills SET active = $1 WHERE workspace_id = $2 AND skill_id = $3`,
      [active ?? true, id, skill]
    );

    return ok({ message: `${skill} ${active ? "activated" : "deactivated"} on ${id}` });
  } catch (e) {
    return err(`Failed to update skill status: ${(e as Error).message}`, 500);
  }
}
