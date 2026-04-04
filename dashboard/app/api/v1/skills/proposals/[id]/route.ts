import { query, queryOne, queryAll } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";
import { loadAllManifests } from "@/lib/manifests";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await request.json();

  if (action !== "approve" && action !== "reject") {
    return err("Action must be 'approve' or 'reject'");
  }

  try {
    const proposal = await queryOne<{
      id: number;
      skill_id: string;
      proposed_version: string;
      proposed_improvement: string;
    }>(
      `SELECT id, skill_id, proposed_version, proposed_improvement FROM skill_proposals WHERE id = $1`,
      [parseInt(id, 10)]
    );

    if (!proposal) return notFound("Proposal");

    if (action === "reject") {
      await query(
        `UPDATE skill_proposals SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`,
        [parseInt(id, 10)]
      );
      return ok({ id: parseInt(id, 10), status: "rejected" });
    }

    // Approve: update status, then propagate
    await query(
      `UPDATE skill_proposals SET status = 'reviewed', reviewed_at = NOW() WHERE id = $1`,
      [parseInt(id, 10)]
    );

    // Record in skill_versions
    await query(
      `INSERT INTO skill_versions (skill_id, version, status, promoted_at)
       VALUES ($1, $2, 'stable', NOW())
       ON CONFLICT (skill_id, version) DO UPDATE SET status = 'stable', promoted_at = NOW()`,
      [proposal.skill_id, proposal.proposed_version]
    );

    // Propagate to subscribed workspaces
    const [category, name] = proposal.skill_id.split("/");
    const skillPath = `skills/${category}/${name}/`;
    const propagationResults: Record<string, string> = {};

    // Get all workspaces that subscribe to this skill
    const subscribers = await queryAll<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_skills WHERE skill_id = $1`,
      [proposal.skill_id]
    );

    const manifests = await loadAllManifests();
    const manifestMap = new Map(manifests.map((m) => [m.id, m]));

    for (const sub of subscribers) {
      const manifest = manifestMap.get(sub.workspace_id);
      if (!manifest?.ssh) {
        propagationResults[sub.workspace_id] = "skipped (no SSH)";
        continue;
      }

      try {
        await exec("rsync", [
          "-av", "--delete",
          `${NEXAAS_ROOT}/${skillPath}`,
          `${manifest.ssh.user}@${manifest.ssh.host}:/opt/nexaas/${skillPath}`,
        ], { timeout: 30000 });
        propagationResults[sub.workspace_id] = "synced";
      } catch (e) {
        propagationResults[sub.workspace_id] = `failed: ${(e as Error).message}`;
      }
    }

    // Git commit the skill update
    try {
      await exec("git", ["add", skillPath, "skills/_registry.yaml"], { cwd: NEXAAS_ROOT });
      await exec("git", [
        "-c", "user.name=Nexmatic", "-c", "user.email=ops@nexmatic.com",
        "commit", "-m", `promote: ${proposal.skill_id} v${proposal.proposed_version}\n\n${proposal.proposed_improvement}`,
      ], { cwd: NEXAAS_ROOT });
      await exec("git", ["push"], { cwd: NEXAAS_ROOT });
    } catch {
      // Git commit may fail if nothing changed on disk
    }

    // Mark proposal as deployed
    await query(
      `UPDATE skill_proposals SET status = 'deployed' WHERE id = $1`,
      [parseInt(id, 10)]
    );

    return ok({
      id: parseInt(id, 10),
      status: "deployed",
      propagation: propagationResults,
    });
  } catch (e) {
    return err(`Failed to process proposal: ${(e as Error).message}`, 500);
  }
}
