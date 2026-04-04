import { loadAllManifests } from "@/lib/manifests";
import { queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";
import type { HealthSnapshot } from "@/lib/types";

export async function GET() {
  try {
    const manifests = await loadAllManifests();

    // Get latest health snapshot per workspace
    const snapshots = await queryAll<HealthSnapshot>(
      `SELECT DISTINCT ON (workspace_id) *
       FROM ops_health_snapshots
       WHERE workspace_id IS NOT NULL
       ORDER BY workspace_id, snapshot_at DESC`
    );

    const healthByWorkspace = new Map(snapshots.map((s) => [s.workspace_id, s]));

    const instances = manifests.map((m) => ({
      id: m.id,
      name: m.name,
      privateIp: m.network.privateIp,
      publicIp: m.network.publicIp,
      health: healthByWorkspace.get(m.id) ?? null,
      manifest: m,
    }));

    return ok(instances);
  } catch (e) {
    return err(`Failed to load instances: ${(e as Error).message}`, 500);
  }
}
