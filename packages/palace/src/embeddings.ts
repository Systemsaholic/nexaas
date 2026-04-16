import { sql } from "./db.js";
import type { RoomPath } from "./types.js";

export interface EmbeddingResult {
  drawer_id: string;
  content: string;
  similarity: number;
  wing: string;
  hall: string;
  room: string;
}

export async function upsertEmbedding(
  workspace: string,
  drawerId: string,
  room: RoomPath,
  embedding: number[],
  model: string = "voyage-3",
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await sql(
    `INSERT INTO nexaas_memory.embeddings
      (workspace, drawer_id, wing, hall, room, embedding, model)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
     ON CONFLICT (id) DO UPDATE SET embedding = $6::vector, model = $7`,
    [workspace, drawerId, room.wing, room.hall, room.room, vectorStr, model],
  );
}

export async function searchSimilar(
  workspace: string,
  queryEmbedding: number[],
  opts?: {
    room?: RoomPath;
    limit?: number;
    minSimilarity?: number;
  },
): Promise<EmbeddingResult[]> {
  const limit = opts?.limit ?? 5;
  const minSim = opts?.minSimilarity ?? 0.5;
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  const conditions = ["e.workspace = $1"];
  const params: unknown[] = [workspace];
  let paramIdx = 2;

  if (opts?.room) {
    conditions.push(`e.wing = $${paramIdx}`);
    params.push(opts.room.wing);
    paramIdx++;
    conditions.push(`e.hall = $${paramIdx}`);
    params.push(opts.room.hall);
    paramIdx++;
    conditions.push(`e.room = $${paramIdx}`);
    params.push(opts.room.room);
    paramIdx++;
  }

  const query = `
    SELECT
      e.drawer_id,
      ev.content,
      1 - (e.embedding <=> $${paramIdx}::vector) AS similarity,
      e.wing, e.hall, e.room
    FROM nexaas_memory.embeddings e
    JOIN nexaas_memory.events ev ON ev.id = e.drawer_id
    WHERE ${conditions.join(" AND ")}
      AND 1 - (e.embedding <=> $${paramIdx}::vector) >= $${paramIdx + 1}
    ORDER BY e.embedding <=> $${paramIdx}::vector
    LIMIT $${paramIdx + 2}
  `;
  params.push(vectorStr, minSim, limit);

  return sql<EmbeddingResult>(query, params);
}
