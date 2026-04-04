import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await request.json();

  try {
    const manifest = await loadManifest(id);
    if (!manifest.ssh) return notFound("SSH config");

    let command: string;
    switch (action) {
      case "restart-worker":
        command = "sudo systemctl restart nexaas-worker 2>&1";
        break;
      case "restart-containers":
        command = "cd /opt/nexaas/platform && docker compose -f docker-compose.orchestrator.yml -p trigger restart 2>&1";
        break;
      case "worker-status":
        command = "sudo systemctl status nexaas-worker --no-pager 2>&1";
        break;
      case "container-status":
        command = "docker ps --format '{{.Names}}\\t{{.Status}}' 2>/dev/null";
        break;
      case "env-vars":
        command = "cat /opt/nexaas/.env 2>/dev/null | grep -v SECRET | grep -v PASSWORD | grep -v KEY || echo 'No .env found'";
        break;
      default:
        return err(`Unknown action: ${action}`);
    }

    const result = await sshExec(manifest, command, 30000);
    return ok({
      action,
      exitCode: result.exitCode,
      output: result.stdout || result.stderr,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Action failed: ${msg}`, 500);
  }
}
