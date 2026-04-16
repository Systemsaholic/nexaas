/**
 * RAG — Retrieval-Augmented Generation.
 *
 * Retrieves semantically similar historical drawers via pgvector,
 * scoped to workspace + declared retrieval rooms.
 * Runs after CAG so retrieval is context-informed.
 */

import { searchSimilar } from "@nexaas/palace";
import type { PalaceSession } from "@nexaas/palace";
import type { AssembledContext } from "../cag/assemble.js";
import type { RetrievalChunk } from "../models/gateway.js";

export interface RetrieveParams {
  session: PalaceSession;
  context: AssembledContext;
}

async function embedQuery(text: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;

  if (!apiKey) {
    // Hash-based fallback for development (same as legacy memory MCP)
    const { createHash } = await import("crypto");
    const hash = createHash("sha512").update(text).digest();
    const embedding: number[] = [];
    for (let i = 0; i < 1024; i++) {
      embedding.push((hash[i % hash.length]! / 255) * 2 - 1);
    }
    return embedding;
  }

  // Call Voyage-3 API
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "voyage-3",
      input: [text],
      input_type: "query",
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voyage API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0]!.embedding;
}

export async function retrieve(params: RetrieveParams): Promise<RetrievalChunk[]> {
  const { session, context } = params;

  if (context.retrievalRooms.length === 0) return [];

  // Build a query from the most recent user message in the context
  const lastUserMessage = [...context.messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMessage) return [];

  const queryText = lastUserMessage.content.slice(0, 1000);

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(queryText);
  } catch {
    // If embedding fails, return empty — RAG is additive, not critical
    return [];
  }

  const allChunks: RetrievalChunk[] = [];

  // Search each retrieval room
  for (const room of context.retrievalRooms) {
    const results = await searchSimilar(
      session.ctx.workspace,
      queryEmbedding,
      {
        room,
        limit: 3,
        minSimilarity: 0.5,
      },
    );

    for (const r of results) {
      allChunks.push({
        content: r.content,
        source: `${r.wing}/${r.hall}/${r.room}`,
        relevance: r.similarity,
      });
    }
  }

  // Sort by relevance, take top N
  allChunks.sort((a, b) => b.relevance - a.relevance);
  return allChunks.slice(0, 10);
}
