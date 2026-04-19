/**
 * Document Ingest Pipeline — chunk, embed, and index documents in the palace.
 *
 * Called after a document is stored in the palace. Runs asynchronously
 * so the upload returns immediately and ingestion happens in the background.
 *
 * Pipeline:
 * 1. Split document into chunks (800-1500 chars, paragraph-aware)
 * 2. Store each chunk as a separate palace drawer
 * 3. Generate embeddings for each chunk (Voyage-3 or hash fallback)
 * 4. Store embeddings in pgvector for semantic search
 */

import { sql } from "@nexaas/palace";
import { chunkAndStore } from "./chunker.js";
import { embedDrawer } from "./embedder.js";

export interface IngestResult {
  drawerId: string;
  chunks: number;
  embedded: number;
}

export async function ingestDocument(
  workspace: string,
  drawerId: string,
  room: { wing: string; hall: string; room: string },
  content: string,
  metadata: Record<string, unknown>,
): Promise<IngestResult> {

  // 1. Chunk the document
  const chunkResult = await chunkAndStore(workspace, drawerId, room, content, metadata);

  // 2. Embed each chunk
  let embedded = 0;

  if (chunkResult.chunkCount === 1) {
    // Single chunk — embed the original drawer
    try {
      await embedDrawer(workspace, drawerId, room, content);
      embedded = 1;
    } catch { /* non-fatal */ }
  } else {
    // Multiple chunks — embed each one
    for (let i = 0; i < chunkResult.drawerIds.length; i++) {
      const chunkId = chunkResult.drawerIds[i];
      // Read chunk content from palace
      const chunkRows = await sql<{ content: string }>(
        `SELECT content FROM nexaas_memory.events WHERE id = $1::uuid`,
        [chunkId],
      );

      if (chunkRows.length > 0) {
        try {
          await embedDrawer(workspace, chunkId, {
            wing: room.wing,
            hall: room.hall,
            room: `${room.room}__chunk_${i}`,
          }, chunkRows[0].content);
          embedded++;
        } catch { /* continue */ }
      }
    }
  }

  // 3. Update parent drawer metadata
  await sql(
    `UPDATE nexaas_memory.events
     SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{ingested}',
       $2::jsonb
     )
     WHERE id = $1::uuid`,
    [drawerId, JSON.stringify({
      chunks: chunkResult.chunkCount,
      embedded,
      ingested_at: new Date().toISOString(),
    })],
  );

  return {
    drawerId,
    chunks: chunkResult.chunkCount,
    embedded,
  };
}
