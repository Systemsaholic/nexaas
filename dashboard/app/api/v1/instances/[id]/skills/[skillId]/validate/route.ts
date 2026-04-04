import { loadManifest } from "@/lib/manifests";
import { getSkillPackage } from "@/lib/skill-packages";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; skillId: string }> }
) {
  const { id, skillId } = await params;
  const skill = skillId.replace("--", "/");

  try {
    const manifest = await loadManifest(id);
    const pkg = await getSkillPackage(skill);

    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required MCP servers from contract
    if (pkg.contract) {
      const requires = (pkg.contract as any).requires ?? {};
      const instanceMcp = Object.keys(manifest.mcp ?? {});

      for (const [integration, _scopes] of Object.entries(requires)) {
        // Map integration names to MCP server IDs
        const serverName = integration.replace("_adapter", "").replace("_", "-");
        if (!instanceMcp.includes(serverName) && serverName !== "notification" && serverName !== "bank-csv" && serverName !== "document-store") {
          errors.push(`Missing integration: ${integration} (MCP server: ${serverName})`);
        }
      }

      // Check capabilities
      const requiredCaps = (pkg.contract as any).execution?.type === "agentic"
        ? ["docker", "bash"]
        : [];
      for (const cap of requiredCaps) {
        if (!manifest.capabilities?.[cap]) {
          warnings.push(`Capability '${cap}' not enabled on instance`);
        }
      }
    }

    // Check if client config exists on instance (via SSH)
    // For now, just check if the skill files are deployed
    const { sshExec } = await import("@/lib/ssh");
    const [category, name] = skill.split("/");
    const checkResult = await sshExec(manifest, `test -f /opt/nexaas/skills/${category}/${name}/contract.yaml && echo 'deployed' || echo 'missing'`);
    if (checkResult.stdout.trim() !== "deployed") {
      errors.push("Skill package not deployed to instance");
    }

    const valid = errors.length === 0;

    return ok({
      valid,
      errors,
      warnings,
      skill,
      instance: id,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace or skill");
    return err(`Validation failed: ${msg}`, 500);
  }
}
