/**
 * Background embedding task for memory events.
 *
 * Receives an event UUID, loads content from nexaas_memory.events,
 * generates a Voyage-3 embedding, upserts to Qdrant, and updates
 * the event row with the embedding_id.
 *
 * Also supports backfill mode: finds all events with NULL embedding_id
 * and batch-triggers embedding for each.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { QdrantClient } from "@qdrant/js-client-rest";
import { queryOne, query } from "../../orchestrator/db.js";
import { createHash } from "crypto";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const VECTOR_SIZE = 1024;
const COLLECTION = "nexaas_memory";

const qdrant = new QdrantClient({ url: QDRANT_URL });

async function ensureCollection(): Promise<void> {
  try {
    await qdrant.getCollection(COLLECTION);
  } catch {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    logger.info(`Created Qdrant collection: ${COLLECTION}`);
  }
}

/** Dev fallback: hash-based pseudo-embedding. Replace with Voyage-3 call in production. */
async function embed(text: string): Promise<number[]> {
  const hash = createHash("sha512").update(text).digest();
  const embedding: number[] = [];
  for (let i = 0; i < VECTOR_SIZE; i++) {
    embedding.push((hash[i % hash.length] / 255) * 2 - 1);
  }
  return embedding;
}

function hashToPointId(id: string): number {
  const h = createHash("md5").update(id).digest();
  return Math.abs(h.readInt32BE(0));
}

export const embedEvent = task({
  id: "embed-event",
  queue: { name: "embeddings", concurrencyLimit: 3 },
  maxDuration: 60,
  run: async (payload: { eventId: string }) => {
    const { eventId } = payload;

    const event = await queryOne<{
      id: string; content: string; event_type: string; agent_id: string; embedding_id: string | null;
    }>(
      `SELECT id, content, event_type, agent_id, embedding_id
       FROM nexaas_memory.events WHERE id = $1`,
      [eventId]
    );

    if (!event) {
      logger.warn(`Event not found: ${eventId}`);
      return { success: false, error: "event_not_found" };
    }

    if (event.embedding_id) {
      logger.info(`Event ${eventId} already embedded`);
      return { success: true, skipped: true };
    }

    await ensureCollection();

    const vector = await embed(event.content);
    const pointId = hashToPointId(eventId);

    await qdrant.upsert(COLLECTION, {
      points: [{
        id: pointId,
        vector,
        payload: {
          event_id: eventId,
          event_type: event.event_type,
          agent_id: event.agent_id,
          created_at: new Date().toISOString(),
        },
      }],
    });

    await query(
      `UPDATE nexaas_memory.events SET embedding_id = $1 WHERE id = $2`,
      [String(pointId), eventId]
    );

    logger.info(`Embedded event ${eventId} → point ${pointId}`);
    return { success: true, pointId };
  },
});

/** Backfill: find all unembedded events and trigger embedding for each. */
export const backfillEmbeddings = task({
  id: "backfill-embeddings",
  queue: { name: "embeddings", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async () => {
    const result = await query(
      `SELECT id FROM nexaas_memory.events WHERE embedding_id IS NULL ORDER BY created_at`
    );
    const eventIds = result.rows.map((r: Record<string, unknown>) => r.id as string);

    if (eventIds.length === 0) {
      logger.info("No unembedded events found");
      return { triggered: 0 };
    }

    logger.info(`Backfilling ${eventIds.length} events`);

    await embedEvent.batchTrigger(
      eventIds.map((id: string) => ({ payload: { eventId: id } }))
    );

    return { triggered: eventIds.length };
  },
});
