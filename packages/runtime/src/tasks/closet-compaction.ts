/**
 * Closet compaction — background task that builds precomputed
 * pointer indexes over drawers in each room.
 *
 * Runs on a cadence (default 5 min business hours, 30 min off-hours).
 * Groups drawers by shared metadata and produces closet rows
 * for fast CAG scanning.
 */

import { sql } from "@nexaas/palace";

interface RoomToCompact {
  workspace: string;
  wing: string;
  hall: string;
  room: string;
  new_drawer_count: number;
}

export async function runCompaction(workspace: string): Promise<number> {
  // Find rooms with drawers newer than their last compaction
  const rooms = await sql<RoomToCompact>(`
    SELECT
      e.workspace, e.wing, e.hall, e.room,
      count(*) as new_drawer_count
    FROM nexaas_memory.events e
    LEFT JOIN nexaas_memory.room_compaction_state rcs
      ON rcs.workspace = e.workspace
      AND rcs.wing = e.wing
      AND rcs.hall = e.hall
      AND rcs.room = e.room
    WHERE e.workspace = $1
      AND e.wing IS NOT NULL
      AND e.created_at > COALESCE(rcs.last_compacted_at, '1970-01-01')
    GROUP BY e.workspace, e.wing, e.hall, e.room
    HAVING count(*) > 0
    ORDER BY count(*) DESC
    LIMIT 20
  `, [workspace]);

  let totalCompacted = 0;

  for (const room of rooms) {
    const start = Date.now();
    try {
      // Load new drawers since last compaction
      const drawers = await sql<{ id: string; content: string; created_at: Date }>(`
        SELECT id, left(content, 200) as content, created_at
        FROM nexaas_memory.events
        WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4
          AND created_at > COALESCE(
            (SELECT last_compacted_at FROM nexaas_memory.room_compaction_state
             WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4),
            '1970-01-01'
          )
        ORDER BY created_at ASC
        LIMIT 100
      `, [room.workspace, room.wing, room.hall, room.room]);

      if (drawers.length === 0) continue;

      // Simple deterministic clustering: group by first 50 chars as topic proxy
      const clusters = new Map<string, string[]>();
      for (const d of drawers) {
        const topic = d.content.slice(0, 50).replace(/[^a-zA-Z0-9 ]/g, "").trim() || "misc";
        if (!clusters.has(topic)) clusters.set(topic, []);
        clusters.get(topic)!.push(d.id);
      }

      // Upsert closet rows
      for (const [topic, drawerIds] of clusters) {
        await sql(`
          INSERT INTO nexaas_memory.closets (workspace, wing, hall, room, topic, drawer_ids)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [room.workspace, room.wing, room.hall, room.room, topic, drawerIds]);
      }

      const durationMs = Date.now() - start;

      // Update compaction state
      await sql(`
        INSERT INTO nexaas_memory.room_compaction_state
          (workspace, wing, hall, room, last_compacted_at, last_compaction_duration_ms, last_drawers_compacted)
        VALUES ($1, $2, $3, $4, now(), $5, $6)
        ON CONFLICT (workspace, wing, hall, room) DO UPDATE SET
          last_compacted_at = now(),
          last_compaction_duration_ms = $5,
          last_drawers_compacted = $6,
          last_error = NULL,
          last_error_at = NULL
      `, [room.workspace, room.wing, room.hall, room.room, durationMs, drawers.length]);

      totalCompacted += drawers.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql(`
        INSERT INTO nexaas_memory.room_compaction_state
          (workspace, wing, hall, room, last_error, last_error_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (workspace, wing, hall, room) DO UPDATE SET
          last_error = $5, last_error_at = now()
      `, [room.workspace, room.wing, room.hall, room.room, message]);
    }
  }

  return totalCompacted;
}
