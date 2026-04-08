import { queryOne, queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // Latest snapshot
    const latest = await queryOne(
      `SELECT * FROM memory_snapshots
       WHERE workspace_id = $1
       ORDER BY snapshot_at DESC
       LIMIT 1`,
      [id]
    );

    // 24h history (up to 24 hourly snapshots)
    const history = await queryAll(
      `SELECT snapshot_at, event_count, entity_count, active_fact_count,
              relation_count, embedding_lag, events_24h
       FROM memory_snapshots
       WHERE workspace_id = $1
         AND snapshot_at > NOW() - INTERVAL '24 hours'
       ORDER BY snapshot_at ASC`,
      [id]
    );

    return ok({ latest, history });
  } catch (e) {
    return err(`Failed to load memory stats: ${(e as Error).message}`, 500);
  }
}
