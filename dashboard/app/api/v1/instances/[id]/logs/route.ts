import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);

    if (id === "nexaas-core") {
      // Local — no SSH needed
      const { execSync } = await import("node:child_process");
      const logs = execSync("journalctl -u nexaas-worker --no-pager -n 100 2>/dev/null || echo 'No worker logs'", {
        timeout: 10000,
      }).toString();
      return ok({ logs });
    }

    if (!manifest.ssh) return notFound("SSH config");

    const result = await sshExec(
      manifest,
      "journalctl -u nexaas-worker --no-pager -n 100 2>/dev/null || echo 'No worker logs'"
    );

    return ok({ logs: result.stdout || result.stderr || "No output" });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Failed to fetch logs: ${msg}`, 500);
  }
}
