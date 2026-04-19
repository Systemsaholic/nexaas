/**
 * Auto-embedder — generates vector embeddings for palace drawers.
 *
 * Uses Voyage-3 API when available, falls back to hash-based
 * embeddings for development. Embeddings enable semantic search
 * via pgvector cosine similarity.
 */

import { upsertEmbedding } from "@nexaas/palace";

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

export async function embedText(text: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) {
    return hashEmbedding(text);
  }

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: [text.slice(0, 8000)], // Voyage max input
      input_type: "document",
    }),
  });

  if (!response.ok) {
    console.warn(`[embedder] Voyage API error ${response.status}, using hash fallback`);
    return hashEmbedding(text);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0]!.embedding;
}

function hashEmbedding(text: string): number[] {
  const { createHash } = require("crypto");
  const hash = createHash("sha512").update(text).digest();
  const embedding: number[] = [];
  for (let i = 0; i < 1024; i++) {
    embedding.push((hash[i % hash.length]! / 255) * 2 - 1);
  }
  return embedding;
}

export async function embedDrawer(
  workspace: string,
  drawerId: string,
  room: { wing: string; hall: string; room: string },
  content: string,
): Promise<void> {
  if (!content || content.length < 10) return;

  try {
    const embedding = await embedText(content);
    await upsertEmbedding(workspace, drawerId, room, embedding);
  } catch (e) {
    console.warn(`[embedder] Failed to embed drawer ${drawerId}: ${(e as Error).message}`);
  }
}

export async function embedChunks(
  workspace: string,
  chunks: Array<{ id: string; room: { wing: string; hall: string; room: string }; content: string }>,
): Promise<number> {
  let embedded = 0;

  for (const chunk of chunks) {
    try {
      await embedDrawer(workspace, chunk.id, chunk.room, chunk.content);
      embedded++;
    } catch {
      // Continue embedding other chunks
    }
  }

  return embedded;
}
