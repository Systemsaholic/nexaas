/**
 * Qdrant RAG Client — vector search for skill context.
 *
 * Architecture Guide v4 §9
 *
 * Namespaces:
 * - {client}_knowledge: client docs, runbooks, contacts, history
 * - skill/{skill}-docs: skill guides, templates, taxonomy
 * - global/email_policies: platform-wide communication standards
 * - global/compliance: PIPEDA, CASL, GDPR, industry rules
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@trigger.dev/sdk/v3";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const EMBEDDING_MODEL = "voyage-3"; // or use Anthropic if available
const VECTOR_SIZE = 1024; // Anthropic embeddings dimension

let _client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({ url: QDRANT_URL });
  }
  return _client;
}

export interface RagChunk {
  content: string;
  source: string;
  relevance: number;
}

/**
 * Ensure a collection exists for a namespace.
 */
export async function ensureCollection(namespace: string): Promise<void> {
  const client = getClient();
  const collectionName = sanitizeCollectionName(namespace);

  try {
    await client.getCollection(collectionName);
  } catch {
    // Collection doesn't exist, create it
    await client.createCollection(collectionName, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    logger.info(`Created Qdrant collection: ${collectionName}`);
  }
}

/**
 * Generate embedding for text using Anthropic API.
 * Falls back to a simple hash-based embedding for development.
 */
async function embed(text: string): Promise<number[]> {
  // Use Anthropic's embedding if available
  try {
    const anthropic = new Anthropic();
    // Anthropic doesn't have embeddings API yet — use a simple approach
    // In production, use voyage-ai or OpenAI embeddings
    // For now: hash-based pseudo-embedding for development
  } catch { /* fallback */ }

  // Development fallback: deterministic pseudo-embedding from text hash
  // This allows the pipeline to work end-to-end without a real embedding model
  const crypto = await import("crypto");
  const hash = crypto.createHash("sha512").update(text).digest();
  const embedding: number[] = [];
  for (let i = 0; i < VECTOR_SIZE; i++) {
    embedding.push((hash[i % hash.length] / 255) * 2 - 1);
  }
  return embedding;
}

/**
 * Index a document chunk into a namespace.
 */
export async function indexChunk(
  namespace: string,
  id: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const client = getClient();
  const collectionName = sanitizeCollectionName(namespace);

  await ensureCollection(namespace);

  const vector = await embed(content);

  await client.upsert(collectionName, {
    points: [
      {
        id: hashToInt(id),
        vector,
        payload: {
          content,
          source: metadata.source ?? id,
          ...metadata,
        },
      },
    ],
  });
}

/**
 * Index a full document (split into chunks first).
 */
export async function indexDocument(
  namespace: string,
  documentId: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const chunks = splitIntoChunks(content);
  let indexed = 0;

  for (let i = 0; i < chunks.length; i++) {
    await indexChunk(
      namespace,
      `${documentId}_chunk_${i}`,
      chunks[i],
      { ...metadata, chunkIndex: i, totalChunks: chunks.length },
    );
    indexed++;
  }

  return indexed;
}

/**
 * Search for relevant chunks in a namespace.
 */
export async function searchChunks(
  namespace: string,
  queryText: string,
  limit: number = 3,
  minRelevance: number = 0.5,
): Promise<RagChunk[]> {
  const client = getClient();
  const collectionName = sanitizeCollectionName(namespace);

  try {
    const queryVector = await embed(queryText);

    const results = await client.search(collectionName, {
      vector: queryVector,
      limit,
      score_threshold: minRelevance,
    });

    return results.map((r) => ({
      content: (r.payload?.content as string) ?? "",
      source: (r.payload?.source as string) ?? "unknown",
      relevance: r.score,
    }));
  } catch (e) {
    // Collection may not exist yet
    logger.warn(`RAG search failed for ${namespace}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Retrieve relevant docs using cascade search strategy.
 *
 * Architecture Guide v4 §9.2:
 * 1. Client namespace first
 * 2. Skill docs
 * 3. Global fallback
 */
export async function retrieveRelevantDocs(
  query: string,
  options: {
    clientNamespace: string;
    skillDocsNamespace?: string;
    fallbackNamespace?: string;
    limit?: number;
    minRelevance?: number;
  },
): Promise<RagChunk[]> {
  const limit = options.limit ?? 3;
  const minRelevance = options.minRelevance ?? 0.5;

  // Search client namespace first
  let chunks = await searchChunks(options.clientNamespace, query, limit, minRelevance);

  if (chunks.length >= limit) return chunks;

  // Fall back to skill docs
  if (options.skillDocsNamespace) {
    const skillChunks = await searchChunks(
      options.skillDocsNamespace, query, limit - chunks.length, minRelevance
    );
    chunks = [...chunks, ...skillChunks];
  }

  if (chunks.length >= limit) return chunks.slice(0, limit);

  // Fall back to global
  if (options.fallbackNamespace) {
    const globalChunks = await searchChunks(
      options.fallbackNamespace, query, limit - chunks.length, minRelevance
    );
    chunks = [...chunks, ...globalChunks];
  }

  return chunks.slice(0, limit);
}

// ── Helpers ────────────────────────────────────────────────────────────

function sanitizeCollectionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function splitIntoChunks(text: string, maxChunkSize: number = 500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxChunkSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
