import { queryAll, query } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

// GET: List channels for this instance
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const channels = await queryAll(
      `SELECT * FROM channel_registry WHERE workspace_id = $1 ORDER BY display_name`,
      [id]
    );
    return ok(channels);
  } catch (e) {
    return err(`Failed to load channels: ${(e as Error).message}`, 500);
  }
}

// POST: Register a new channel
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const channel = await request.json();

  if (!channel.channelId || !channel.displayName || !channel.direction) {
    return err("channelId, displayName, and direction are required");
  }

  try {
    await query(
      `INSERT INTO channel_registry
       (workspace_id, channel_id, display_name, direction, criticality, latency,
        implementation, capabilities, fallback_channel, health_check, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       ON CONFLICT (workspace_id, channel_id) DO UPDATE SET
         display_name = $3, direction = $4, criticality = $5, latency = $6,
         implementation = $7, capabilities = $8, fallback_channel = $9, health_check = $10`,
      [
        id,
        channel.channelId,
        channel.displayName,
        channel.direction,
        channel.criticality ?? "standard",
        channel.latency ?? "async",
        JSON.stringify(channel.implementation ?? {}),
        channel.capabilities ?? [],
        channel.fallbackChannel ?? null,
        channel.healthCheck ?? true,
      ]
    );
    return ok({ message: `Channel ${channel.channelId} registered` });
  } catch (e) {
    return err(`Failed to register channel: ${(e as Error).message}`, 500);
  }
}
