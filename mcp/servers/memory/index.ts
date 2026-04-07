/**
 * Nexaas Memory MCP Server
 *
 * Exposes all memory operations as MCP tools: event log, knowledge graph,
 * agent journal, and semantic search. This is the sole interface for all
 * memory reads and writes — agents never access the DB or Qdrant directly.
 *
 * Transport: stdio (consistent with all Nexaas MCP servers)
 * Schema: nexaas_memory (separate Postgres schema)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "crypto";

// ── Database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});

async function sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

async function sqlOne<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

// ── Qdrant ──────────────────────────────────────────────────────────────

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
  }
}

/** Hash-based pseudo-embedding (dev fallback). Replace with Voyage-3 in production. */
async function embed(text: string): Promise<number[]> {
  const hash = createHash("sha512").update(text).digest();
  const embedding: number[] = [];
  for (let i = 0; i < VECTOR_SIZE; i++) {
    embedding.push((hash[i % hash.length] / 255) * 2 - 1);
  }
  return embedding;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashToPointId(id: string): number {
  const h = createHash("md5").update(id).digest();
  return Math.abs(h.readInt32BE(0));
}

// ── Helpers ─────────────────────────────────────────────────────────────

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({ name: "nexaas-memory", version: "1.0.0" });

// ── Write Tools ─────────────────────────────────────────────────────────

server.tool(
  "memory_store",
  "Store a verbatim event in the memory log. Every agent action, decision, skill run, approval, and error should be stored here.",
  {
    agent_id: z.string().describe("Agent identifier (e.g. it-admin-v1, booking-agent)"),
    event_type: z.enum(["decision", "action", "skill_run", "human_approval", "error", "preference", "context"])
      .describe("Type of event"),
    content: z.string().describe("Full verbatim content — never truncated or summarized"),
    metadata: z.record(z.unknown()).optional().describe("Tool name, input params, skill version, etc."),
    parent_event_id: z.string().optional().describe("UUID of event this corrects or follows up"),
    trigger_task_id: z.string().optional().describe("Trigger.dev run ID"),
  },
  async ({ agent_id, event_type, content, metadata, parent_event_id, trigger_task_id }) => {
    // Content size guard
    if (content.length > 100_000) {
      return jsonResult({ error: "Content exceeds 100KB limit. Truncate before storing." });
    }
    if (content.length > 10_000) {
      console.error(`Warning: large event content (${content.length} bytes) from ${agent_id}`);
    }

    const hash = contentHash(content);

    // Dedup: skip if identical content already stored
    const existing = await sqlOne<{ id: string }>(
      `SELECT id FROM nexaas_memory.events WHERE content_hash = $1 LIMIT 1`,
      [hash]
    );
    if (existing) {
      return jsonResult({ event_id: existing.id, deduplicated: true });
    }

    const row = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.events
       (agent_id, trigger_task_id, event_type, content, content_hash, metadata, parent_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [agent_id, trigger_task_id ?? null, event_type, content, hash,
       JSON.stringify(metadata ?? {}), parent_event_id ?? null]
    );

    const eventId = row!.id;

    // Trigger async embedding via Trigger.dev task (fire-and-forget)
    triggerEmbedding(eventId);

    return jsonResult({ event_id: eventId });
  }
);

server.tool(
  "memory_journal_append",
  "Append a message to the agent's working memory for the current task. Journal entries are scoped to a single Trigger.dev run and flushed to the event log on task completion.",
  {
    agent_id: z.string().describe("Agent identifier"),
    trigger_task_id: z.string().describe("Trigger.dev run ID — scopes the journal"),
    role: z.enum(["system", "user", "assistant"]).describe("Message role"),
    content: z.string().describe("Message content"),
    seq: z.number().int().describe("Sequence number within this task (monotonically increasing)"),
    metadata: z.record(z.unknown()).optional().describe("Tool calls, token counts, etc."),
  },
  async ({ agent_id, trigger_task_id, role, content, seq, metadata }) => {
    const row = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.agent_journal
       (agent_id, trigger_task_id, role, content, seq, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [agent_id, trigger_task_id, role, content, seq, JSON.stringify(metadata ?? {})]
    );
    return jsonResult({ journal_id: row!.id });
  }
);

server.tool(
  "memory_journal_flush",
  "Flush the agent journal for a completed task to the event log. Marks all journal entries as flushed and creates a summary event.",
  {
    trigger_task_id: z.string().describe("Trigger.dev run ID to flush"),
  },
  async ({ trigger_task_id }) => {
    // Get unflushed entries
    const entries = await sql<{ id: string; agent_id: string; role: string; content: string }>(
      `SELECT id, agent_id, role, content FROM nexaas_memory.agent_journal
       WHERE trigger_task_id = $1 AND flushed_at IS NULL
       ORDER BY seq`,
      [trigger_task_id]
    );

    if (entries.length === 0) {
      return jsonResult({ flushed: 0, event_ids: [] });
    }

    const agentId = entries[0].agent_id;
    const summary = entries.map(e => `[${e.role}] ${e.content}`).join("\n---\n");

    // Store combined journal as a single event
    const hash = contentHash(summary);
    const eventRow = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.events
       (agent_id, trigger_task_id, event_type, content, content_hash, metadata)
       VALUES ($1, $2, 'context', $3, $4, $5)
       RETURNING id`,
      [agentId, trigger_task_id, summary, hash,
       JSON.stringify({ source: "journal_flush", entry_count: entries.length })]
    );

    // Mark as flushed
    await sql(
      `UPDATE nexaas_memory.agent_journal SET flushed_at = NOW()
       WHERE trigger_task_id = $1 AND flushed_at IS NULL`,
      [trigger_task_id]
    );

    return jsonResult({ flushed: entries.length, event_ids: [eventRow!.id] });
  }
);

server.tool(
  "memory_upsert_entity",
  "Create or update an entity in the knowledge graph. Uses name + entity_type as the natural key.",
  {
    name: z.string().describe("Canonical entity name"),
    entity_type: z.enum(["client", "project", "system", "person", "concept", "decision"])
      .describe("Entity type"),
    aliases: z.array(z.string()).optional().describe("Alternative names for fuzzy matching"),
    summary: z.string().optional().describe("AI-generated summary of the entity"),
    metadata: z.record(z.unknown()).optional().describe("External IDs, tags, URLs"),
  },
  async ({ name, entity_type, aliases, summary, metadata }) => {
    const row = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.entities (name, entity_type, aliases, summary, metadata)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (LOWER(name), entity_type) DO UPDATE SET
         aliases = COALESCE($3, nexaas_memory.entities.aliases),
         summary = COALESCE($4, nexaas_memory.entities.summary),
         metadata = nexaas_memory.entities.metadata || COALESCE($5, '{}')::jsonb,
         updated_at = NOW()
       RETURNING id`,
      [name, entity_type, aliases ?? [], summary ?? null, JSON.stringify(metadata ?? {})]
    );
    return jsonResult({ entity_id: row!.id });
  }
);

server.tool(
  "memory_add_relation",
  "Add a directed relation between two entities in the knowledge graph.",
  {
    from_name: z.string().describe("Source entity name"),
    relation_type: z.string().describe("Relation type (e.g. uses, manages, decided_by, works_at)"),
    to_name: z.string().describe("Target entity name"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0.0–1.0 (default 1.0)"),
    source_event_id: z.string().optional().describe("Event that established this relation"),
  },
  async ({ from_name, relation_type, to_name, confidence, source_event_id }) => {
    // Resolve entities by name (case-insensitive)
    const fromEntity = await sqlOne<{ id: string }>(
      `SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [from_name]
    );
    const toEntity = await sqlOne<{ id: string }>(
      `SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [to_name]
    );

    if (!fromEntity || !toEntity) {
      const missing = [!fromEntity && from_name, !toEntity && to_name].filter(Boolean);
      return jsonResult({ error: `Entity not found: ${missing.join(", ")}. Create entities first.` });
    }

    const row = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.relations
       (from_entity_id, to_entity_id, relation_type, confidence, source_event_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [fromEntity.id, toEntity.id, relation_type, confidence ?? 1.0, source_event_id ?? null]
    );
    return jsonResult({ relation_id: row!.id });
  }
);

server.tool(
  "memory_add_fact",
  "Add a fact (key-value attribute) to an entity. Automatically supersedes the prior fact for the same entity + key.",
  {
    entity_name: z.string().describe("Entity name to attach the fact to"),
    fact_key: z.string().describe("Fact key (e.g. preferred_db, timezone, contact_email)"),
    fact_value: z.string().describe("Fact value (always text)"),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0.0–1.0"),
    source_event_id: z.string().optional().describe("Originating event UUID"),
  },
  async ({ entity_name, fact_key, fact_value, confidence, source_event_id }) => {
    const entity = await sqlOne<{ id: string }>(
      `SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [entity_name]
    );
    if (!entity) {
      return jsonResult({ error: `Entity not found: ${entity_name}. Create entity first.` });
    }

    // Supersede existing fact for same entity + key
    const existing = await sqlOne<{ id: string }>(
      `SELECT id FROM nexaas_memory.facts
       WHERE entity_id = $1 AND fact_key = $2 AND superseded_by IS NULL
       LIMIT 1`,
      [entity.id, fact_key]
    );

    const row = await sqlOne<{ id: string }>(
      `INSERT INTO nexaas_memory.facts
       (entity_id, fact_key, fact_value, confidence, source_event_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [entity.id, fact_key, fact_value, confidence ?? 1.0, source_event_id ?? null]
    );

    if (existing) {
      await sql(`UPDATE nexaas_memory.facts SET superseded_by = $1 WHERE id = $2`,
        [row!.id, existing.id]);
    }

    return jsonResult({ fact_id: row!.id, superseded: existing?.id ?? null });
  }
);

// ── Read Tools ──────────────────────────────────────────────────────────

server.tool(
  "memory_search",
  "Search memory using semantic similarity and knowledge graph lookup. Returns events ranked by relevance + recency.",
  {
    query: z.string().describe("Search query in natural language"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
    event_types: z.array(z.string()).optional().describe("Filter to specific event types"),
    date_from: z.string().optional().describe("ISO date — only events after this date"),
    date_to: z.string().optional().describe("ISO date — only events before this date"),
  },
  async ({ query, limit, event_types, date_from, date_to }) => {
    // Fan out: Qdrant ANN + Postgres text search in parallel
    const [qdrantResults, pgResults] = await Promise.all([
      searchQdrant(query, limit * 2, event_types),
      searchPostgres(query, limit * 2, event_types, date_from, date_to),
    ]);

    // Merge and re-rank
    const seen = new Set<string>();
    const merged: Array<{ event_id: string; content: string; event_type: string; agent_id: string; created_at: string; score: number }> = [];

    const now = Date.now();

    for (const r of [...qdrantResults, ...pgResults]) {
      if (seen.has(r.event_id)) continue;
      seen.add(r.event_id);

      const ageMs = now - new Date(r.created_at).getTime();
      const recencyScore = Math.max(0, 1 - ageMs / (90 * 24 * 60 * 60 * 1000)); // decay over 90 days
      const typeBoost = r.event_type === "human_approval" ? 0.2 : r.event_type === "decision" ? 0.1 : 0;
      const finalScore = 0.6 * (r.semantic_score ?? 0.5) + 0.3 * recencyScore + 0.1 * typeBoost;

      merged.push({
        event_id: r.event_id,
        content: r.content,
        event_type: r.event_type,
        agent_id: r.agent_id,
        created_at: r.created_at,
        score: Math.round(finalScore * 1000) / 1000,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    return jsonResult({ results: merged.slice(0, limit) });
  }
);

server.tool(
  "memory_get_entity",
  "Get full entity profile including all current facts and relations.",
  {
    name: z.string().describe("Entity name (fuzzy matched)"),
  },
  async ({ name }) => {
    // Fuzzy match on name using pg_trgm
    const entity = await sqlOne<{
      id: string; name: string; entity_type: string; aliases: string[];
      summary: string; metadata: unknown; created_at: string; updated_at: string;
    }>(
      `SELECT * FROM nexaas_memory.entities
       WHERE LOWER(name) = LOWER($1)
          OR name % $1
          OR $1 = ANY(aliases)
       ORDER BY similarity(name, $1) DESC
       LIMIT 1`,
      [name]
    );

    if (!entity) {
      return jsonResult({ error: `No entity found matching: ${name}` });
    }

    const [facts, relationsFrom, relationsTo] = await Promise.all([
      sql(
        `SELECT fact_key, fact_value, confidence, created_at FROM nexaas_memory.facts
         WHERE entity_id = $1 AND superseded_by IS NULL ORDER BY fact_key`,
        [entity.id]
      ),
      sql(
        `SELECT r.relation_type, e.name AS target, r.confidence
         FROM nexaas_memory.relations r JOIN nexaas_memory.entities e ON r.to_entity_id = e.id
         WHERE r.from_entity_id = $1`,
        [entity.id]
      ),
      sql(
        `SELECT r.relation_type, e.name AS source, r.confidence
         FROM nexaas_memory.relations r JOIN nexaas_memory.entities e ON r.from_entity_id = e.id
         WHERE r.to_entity_id = $1`,
        [entity.id]
      ),
    ]);

    return jsonResult({ entity, facts, relations_from: relationsFrom, relations_to: relationsTo });
  }
);

server.tool(
  "memory_get_context",
  "Get the working memory journal for a specific task run, plus recent events from the same agent.",
  {
    trigger_task_id: z.string().describe("Trigger.dev run ID"),
  },
  async ({ trigger_task_id }) => {
    const journal = await sql(
      `SELECT role, content, metadata, seq, created_at FROM nexaas_memory.agent_journal
       WHERE trigger_task_id = $1 AND flushed_at IS NULL
       ORDER BY seq`,
      [trigger_task_id]
    );

    // Also get the agent's recent events for broader context
    let recentEvents: unknown[] = [];
    if (journal.length > 0) {
      const agentId = (journal[0] as { agent_id?: string }).agent_id;
      if (agentId) {
        recentEvents = await sql(
          `SELECT id, event_type, content, created_at FROM nexaas_memory.events
           WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [agentId]
        );
      }
    }

    return jsonResult({ journal, recent_events: recentEvents });
  }
);

server.tool(
  "memory_get_recent",
  "Get the most recent events, optionally filtered by agent or event type.",
  {
    limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    agent_id: z.string().optional().describe("Filter to a specific agent"),
    event_type: z.string().optional().describe("Filter to a specific event type"),
  },
  async ({ limit, agent_id, event_type }) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (agent_id) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(agent_id);
    }
    if (event_type) {
      conditions.push(`event_type = $${paramIdx++}`);
      params.push(event_type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const events = await sql(
      `SELECT id, agent_id, event_type, content, metadata, created_at
       FROM nexaas_memory.events ${where}
       ORDER BY created_at DESC LIMIT $${paramIdx}`,
      params
    );

    return jsonResult({ events });
  }
);

server.tool(
  "memory_status",
  "Get memory system health and statistics.",
  {},
  async () => {
    const [eventCount, entityCount, factCount, relationCount, journalCount, oldestEvent, newestEvent] =
      await Promise.all([
        sqlOne<{ count: string }>(`SELECT COUNT(*) FROM nexaas_memory.events`),
        sqlOne<{ count: string }>(`SELECT COUNT(*) FROM nexaas_memory.entities`),
        sqlOne<{ count: string }>(`SELECT COUNT(*) FROM nexaas_memory.facts WHERE superseded_by IS NULL`),
        sqlOne<{ count: string }>(`SELECT COUNT(*) FROM nexaas_memory.relations`),
        sqlOne<{ count: string }>(`SELECT COUNT(*) FROM nexaas_memory.agent_journal WHERE flushed_at IS NULL`),
        sqlOne<{ min: string }>(`SELECT MIN(created_at) AS min FROM nexaas_memory.events`),
        sqlOne<{ max: string }>(`SELECT MAX(created_at) AS max FROM nexaas_memory.events`),
      ]);

    // Check embedding lag
    const unembedded = await sqlOne<{ count: string }>(
      `SELECT COUNT(*) FROM nexaas_memory.events WHERE embedding_id IS NULL`
    );

    return jsonResult({
      schema_version: "1.0",
      events: parseInt(eventCount?.count ?? "0", 10),
      entities: parseInt(entityCount?.count ?? "0", 10),
      active_facts: parseInt(factCount?.count ?? "0", 10),
      relations: parseInt(relationCount?.count ?? "0", 10),
      active_journal_entries: parseInt(journalCount?.count ?? "0", 10),
      embedding_lag: parseInt(unembedded?.count ?? "0", 10),
      oldest_event: oldestEvent?.min ?? null,
      newest_event: newestEvent?.max ?? null,
    });
  }
);

// ── Trigger.dev Integration ─────────────────────────────────────────────

const TRIGGER_API_URL = process.env.TRIGGER_API_URL ?? "http://localhost:3040";
const TRIGGER_SECRET_KEY = process.env.TRIGGER_SECRET_KEY;

function triggerEmbedding(eventId: string): void {
  if (!TRIGGER_SECRET_KEY) return;
  fetch(`${TRIGGER_API_URL}/api/v1/tasks/embed-event/trigger`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TRIGGER_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload: { eventId } }),
  }).catch(() => {}); // fire-and-forget
}

// ── Search Helpers ──────────────────────────────────────────────────────

interface SearchResult {
  event_id: string;
  content: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  semantic_score?: number;
}

async function searchQdrant(
  query: string, limit: number, eventTypes?: string[]
): Promise<SearchResult[]> {
  try {
    await ensureCollection();
    const vector = await embed(query);

    const filter: Record<string, unknown> = {};
    if (eventTypes && eventTypes.length > 0) {
      filter.must = [{ key: "event_type", match: { any: eventTypes } }];
    }

    const results = await qdrant.search(COLLECTION, {
      vector,
      limit,
      with_payload: true,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    // Hydrate from Postgres to get full content
    const eventIds = results
      .map(r => (r.payload as Record<string, unknown>)?.event_id as string)
      .filter(Boolean);

    if (eventIds.length === 0) return [];

    const events = await sql<SearchResult>(
      `SELECT id AS event_id, content, event_type, agent_id, created_at::text
       FROM nexaas_memory.events WHERE id = ANY($1)`,
      [eventIds]
    );

    const scoreMap = new Map(
      results.map(r => [(r.payload as Record<string, unknown>)?.event_id as string, r.score])
    );

    return events.map(e => ({ ...e, semantic_score: scoreMap.get(e.event_id) ?? 0.5 }));
  } catch {
    return []; // Qdrant unavailable — degrade gracefully
  }
}

async function searchPostgres(
  query: string, limit: number, eventTypes?: string[],
  dateFrom?: string, dateTo?: string
): Promise<SearchResult[]> {
  const conditions: string[] = [];
  const params: unknown[] = [query];
  let paramIdx = 2;

  if (eventTypes && eventTypes.length > 0) {
    conditions.push(`event_type = ANY($${paramIdx++})`);
    params.push(eventTypes);
  }
  if (dateFrom) {
    conditions.push(`created_at >= $${paramIdx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`created_at <= $${paramIdx++}`);
    params.push(dateTo);
  }

  const where = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  params.push(limit);

  // Use pg_trgm similarity on content
  const events = await sql<SearchResult & { sim: number }>(
    `SELECT id AS event_id, content, event_type, agent_id, created_at::text,
            similarity(content, $1) AS sim
     FROM nexaas_memory.events
     WHERE content % $1 ${where}
     ORDER BY sim DESC
     LIMIT $${paramIdx}`,
    params
  );

  return events.map(e => ({ ...e, semantic_score: e.sim }));
}

// ── Start ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Nexaas Memory MCP server failed to start:", err);
  process.exit(1);
});
