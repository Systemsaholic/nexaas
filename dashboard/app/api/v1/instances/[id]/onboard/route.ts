import { loadManifest } from "@/lib/manifests";
import { sshExec } from "@/lib/ssh";
import { ok, err, notFound } from "@/lib/api-response";

// POST: Trigger Foundation Skill on an instance
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const input = await request.json();

  if (!input.businessName) return err("businessName is required");

  try {
    const manifest = await loadManifest(id);
    if (!manifest?.ssh) return notFound("SSH config");

    // Get the Trigger.dev key from the instance
    const keyResult = await sshExec(manifest,
      "grep TRIGGER_SECRET_KEY /opt/nexaas/.env | cut -d= -f2",
      10000
    );
    const triggerKey = keyResult.stdout.trim();

    if (!triggerKey) return err("TRIGGER_SECRET_KEY not found on instance");

    // Trigger the Foundation Skill task on the instance's Trigger.dev
    const payload = {
      workspaceId: id,
      ...input,
    };

    const triggerResult = await sshExec(manifest,
      `curl -s -X POST "http://localhost:3040/api/v1/tasks/client-onboarding/trigger" -H "Authorization: Bearer ${triggerKey}" -H "Content-Type: application/json" -d '${JSON.stringify({ payload }).replace(/'/g, "'\\''")}'`,
      30000
    );

    let runId: string | null = null;
    try {
      const parsed = JSON.parse(triggerResult.stdout);
      runId = parsed.id;
    } catch { /* couldn't parse */ }

    return ok({
      message: `Foundation Skill triggered on ${id}`,
      runId,
      output: triggerResult.stdout,
    });
  } catch (e) {
    return err(`Failed to trigger onboarding: ${(e as Error).message}`, 500);
  }
}
