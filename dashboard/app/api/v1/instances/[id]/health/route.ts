import { loadManifest } from "@/lib/manifests";
import { collectVpsHealth } from "@/lib/ssh";
import { query } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const manifest = await loadManifest(id);
    if (!manifest.ssh) return notFound("SSH config");

    const health = await collectVpsHealth(manifest);
    if (!health) {
      return err("SSH health check failed — VPS unreachable", 502);
    }

    await query(
      `INSERT INTO ops_health_snapshots
       (workspace_id, ram_total_mb, ram_used_mb, disk_total_gb, disk_used_gb,
        container_count, containers_healthy, worker_active, vps_ip, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [id, health.ram_total_mb, health.ram_used_mb, health.disk_total_gb, health.disk_used_gb,
       health.container_count, health.containers_healthy, health.worker_active, health.vps_ip]
    );

    return ok(health);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("ENOENT")) return notFound("Workspace");
    return err(`Health refresh failed: ${msg}`, 500);
  }
}
