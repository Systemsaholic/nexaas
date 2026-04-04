import { loadManifest } from "@/lib/manifests";
import { queryOne, queryAll } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";
import type { HealthSnapshot } from "@/lib/types";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);

    const health = await queryOne<HealthSnapshot>(
      `SELECT * FROM ops_health_snapshots
       WHERE workspace_id = $1
       ORDER BY snapshot_at DESC LIMIT 1`,
      [id]
    );

    // Last 24h of snapshots for mini charts
    const history = await queryAll<HealthSnapshot>(
      `SELECT * FROM ops_health_snapshots
       WHERE workspace_id = $1 AND snapshot_at > NOW() - INTERVAL '24 hours'
       ORDER BY snapshot_at ASC`,
      [id]
    );

    return ok({
      id,
      name: manifest.name,
      privateIp: manifest.network.privateIp,
      publicIp: manifest.network.publicIp,
      health,
      history,
      manifest,
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Failed to load instance: ${msg}`, 500);
  }
}
