import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);
    if (!manifest.ssh) return notFound("SSH config");

    const result = await sshExec(
      manifest,
      "sudo systemctl restart nexaas-worker 2>&1",
      20000
    );

    if (result.exitCode === 0) {
      return ok({ message: `Worker restarted on ${id}` });
    } else {
      return err(`Restart failed: ${result.stderr || result.stdout}`, 500);
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Failed to restart worker: ${msg}`, 500);
  }
}
