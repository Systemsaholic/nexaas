/**
 * Document chunker — splits large documents into searchable chunks.
 *
 * Each chunk is stored as a separate palace drawer with metadata
 * linking it back to the parent document. Chunks are sized for
 * optimal embedding and retrieval (800-1500 chars).
 */

import { sql } from "@nexaas/palace";

export interface ChunkResult {
  parentId: string;
  chunkCount: number;
  drawerIds: string[];
}

const CHUNK_SIZE = 1200;      // target chars per chunk
const CHUNK_OVERLAP = 200;    // overlap between chunks for context continuity
const MIN_CHUNK_SIZE = 100;   // don't create tiny trailing chunks

export function splitIntoChunks(content: string): string[] {
  if (content.length <= CHUNK_SIZE) return [content];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < content.length) {
    let end = pos + CHUNK_SIZE;

    if (end < content.length) {
      // Try to break at a paragraph or sentence boundary
      const remaining = content.slice(pos, end + 200);
      const paragraphBreak = remaining.lastIndexOf("\n\n");
      const sentenceBreak = remaining.lastIndexOf(". ");
      const lineBreak = remaining.lastIndexOf("\n");

      if (paragraphBreak > CHUNK_SIZE * 0.5) {
        end = pos + paragraphBreak + 2;
      } else if (sentenceBreak > CHUNK_SIZE * 0.5) {
        end = pos + sentenceBreak + 2;
      } else if (lineBreak > CHUNK_SIZE * 0.5) {
        end = pos + lineBreak + 1;
      }
    } else {
      end = content.length;
    }

    const chunk = content.slice(pos, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) {
      chunks.push(chunk);
    }

    // Move forward with overlap
    pos = end - CHUNK_OVERLAP;
    if (pos <= (chunks.length > 0 ? end - CHUNK_SIZE : 0)) {
      pos = end; // prevent infinite loop
    }
  }

  return chunks;
}

export async function chunkAndStore(
  workspace: string,
  parentDrawerId: string,
  parentRoom: { wing: string; hall: string; room: string },
  content: string,
  parentMetadata: Record<string, unknown>,
): Promise<ChunkResult> {
  const chunks = splitIntoChunks(content);

  if (chunks.length <= 1) {
    // Single chunk — no need to split, the parent drawer IS the chunk
    return { parentId: parentDrawerId, chunkCount: 1, drawerIds: [parentDrawerId] };
  }

  const drawerIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkMeta = {
      parent_drawer_id: parentDrawerId,
      parent_document: parentRoom.room,
      chunk_index: i,
      chunk_total: chunks.length,
      chunk_type: "document-chunk",
    };

    const result = await sql<{ id: string }>(
      `INSERT INTO nexaas_memory.events
        (workspace, wing, hall, room, content, content_hash, event_type, agent_id, skill_id, metadata)
       VALUES ($1, $2, $3, $4, $5, encode(digest($5, 'sha256'), 'hex'), 'document-chunk', 'chunker', 'document-vault', $6::jsonb)
       RETURNING id::text`,
      [workspace, parentRoom.wing, parentRoom.hall,
       `${parentRoom.room}__chunk_${i}`,
       chunk, JSON.stringify(chunkMeta)],
    );

    if (result.length > 0) {
      drawerIds.push(result[0].id);
    }
  }

  // Update parent metadata with chunk info
  await sql(
    `UPDATE nexaas_memory.events
     SET metadata = jsonb_set(
       COALESCE(metadata, '{}'::jsonb),
       '{chunks}',
       $2::jsonb
     )
     WHERE id = $1::uuid`,
    [parentDrawerId, JSON.stringify({ count: chunks.length, drawer_ids: drawerIds })],
  );

  return { parentId: parentDrawerId, chunkCount: chunks.length, drawerIds };
}
