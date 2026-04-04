import { loadManifest } from "@/lib/manifests";
import { listSkillPackages } from "@/lib/skill-packages";
import { queryAll } from "@/lib/db";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);
    const allPackages = await listSkillPackages();

    // Get deployed skills from workspace_skills table
    const deployed = await queryAll<{
      skill_id: string;
      pinned_version: string | null;
      active: boolean;
    }>(
      `SELECT skill_id, pinned_version, active FROM workspace_skills WHERE workspace_id = $1`,
      [id]
    );

    const deployedMap = new Map(deployed.map((d) => [d.skill_id, d]));

    // Check which skills are in the manifest
    const manifestSkills = new Set(manifest.skills ?? []);

    // Build combined view
    const skills = allPackages.map((pkg) => {
      const dep = deployedMap.get(pkg.id);
      const inManifest = manifestSkills.has(pkg.id);

      let status: string;
      if (dep?.active) {
        status = "active";
      } else if (dep || inManifest) {
        status = "inactive";
      } else {
        status = "not_deployed";
      }

      return {
        id: pkg.id,
        name: pkg.name,
        category: pkg.category,
        type: pkg.type,
        version: pkg.version,
        description: pkg.description,
        status,
        pinnedVersion: dep?.pinned_version ?? null,
      };
    });

    return ok(skills);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Failed to load instance skills: ${msg}`, 500);
  }
}

// Deploy a skill to this instance
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { skillId } = await request.json();

  if (!skillId) return err("skillId is required");

  try {
    const manifest = await loadManifest(id);
    if (!manifest.ssh) return notFound("SSH config");

    const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
    const [category, name] = skillId.split("/");
    const skillPath = `skills/${category}/${name}/`;

    // Rsync skill package to instance
    const result = await sshExec(manifest, `mkdir -p /opt/nexaas/skills/${category}/`, 10000);

    // Use rsync via SSH
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);

    await exec("rsync", [
      "-av", "--delete",
      `${nexaasRoot}/${skillPath}`,
      `${manifest.ssh.user}@${manifest.ssh.host}:/opt/nexaas/${skillPath}`,
    ], { timeout: 30000 });

    // Record in workspace_skills table (local DB)
    const { query } = await import("@/lib/db");
    await query(
      `INSERT INTO workspace_skills (workspace_id, skill_id, active)
       VALUES ($1, $2, false)
       ON CONFLICT (workspace_id, skill_id) DO NOTHING`,
      [id, skillId]
    );

    return ok({ message: `Deployed ${skillId} to ${id}`, status: "inactive" });
  } catch (e) {
    return err(`Failed to deploy skill: ${(e as Error).message}`, 500);
  }
}
