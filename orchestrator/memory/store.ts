/**
 * Internal Memory Store API — for use by Trigger.dev tasks and the skill executor.
 *
 * Provides the same operations as the Memory MCP server tools but callable
 * directly from TypeScript (uses the shared orchestrator/db.ts pool).
 *
 * Agents and Claude Code sessions use the MCP server. Internal code uses this.
 */

import { query, queryOne } from "../db.js";
import { createHash } from "crypto";

// ── Events ──────────────────────────────────────────────────────────────

export interface StoreEventOptions {
  agentId: string;
  eventType: "decision" | "action" | "skill_run" | "human_approval" | "error" | "preference" | "context";
  content: string;
  metadata?: Record<string, unknown>;
  parentEventId?: string;
  triggerTaskId?: string;
}

export async function storeEvent(options: StoreEventOptions): Promise<string> {
  const hash = createHash("sha256").update(options.content).digest("hex");

  // Dedup
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM nexaas_memory.events WHERE content_hash = $1 LIMIT 1`,
    [hash]
  );
  if (existing) return existing.id;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO nexaas_memory.events
     (agent_id, trigger_task_id, event_type, content, content_hash, metadata, parent_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      options.agentId,
      options.triggerTaskId ?? null,
      options.eventType,
      options.content,
      hash,
      JSON.stringify(options.metadata ?? {}),
      options.parentEventId ?? null,
    ]
  );

  return row!.id;
}

// ── Journal ─────────────────────────────────────────────────────────────

export async function appendJournal(
  agentId: string, triggerTaskId: string, role: "system" | "user" | "assistant",
  content: string, seq: number, metadata?: Record<string, unknown>
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO nexaas_memory.agent_journal
     (agent_id, trigger_task_id, role, content, seq, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [agentId, triggerTaskId, role, content, seq, JSON.stringify(metadata ?? {})]
  );
  return row!.id;
}

export async function flushJournal(triggerTaskId: string): Promise<string[]> {
  const entries = await query(
    `SELECT id, agent_id, role, content FROM nexaas_memory.agent_journal
     WHERE trigger_task_id = $1 AND flushed_at IS NULL ORDER BY seq`,
    [triggerTaskId]
  );

  if (entries.rows.length === 0) return [];

  const agentId = (entries.rows[0] as Record<string, unknown>).agent_id as string;
  const summary = entries.rows
    .map((e: Record<string, unknown>) => `[${e.role}] ${e.content}`)
    .join("\n---\n");

  const eventId = await storeEvent({
    agentId,
    eventType: "context",
    content: summary,
    triggerTaskId,
    metadata: { source: "journal_flush", entry_count: entries.rows.length },
  });

  await query(
    `UPDATE nexaas_memory.agent_journal SET flushed_at = NOW()
     WHERE trigger_task_id = $1 AND flushed_at IS NULL`,
    [triggerTaskId]
  );

  return [eventId];
}

// ── Entities ────────────────────────────────────────────────────────────

export async function upsertEntity(
  name: string, entityType: string, aliases?: string[], summary?: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO nexaas_memory.entities (name, entity_type, aliases, summary, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (LOWER(name), entity_type) DO UPDATE SET
       aliases = COALESCE($3, nexaas_memory.entities.aliases),
       summary = COALESCE($4, nexaas_memory.entities.summary),
       metadata = nexaas_memory.entities.metadata || COALESCE($5, '{}')::jsonb,
       updated_at = NOW()
     RETURNING id`,
    [name, entityType, aliases ?? [], summary ?? null, JSON.stringify(metadata ?? {})]
  );
  return row!.id;
}

export async function addFact(
  entityName: string, factKey: string, factValue: string,
  confidence?: number, sourceEventId?: string
): Promise<string> {
  const entity = await queryOne<{ id: string }>(
    `SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [entityName]
  );
  if (!entity) throw new Error(`Entity not found: ${entityName}`);

  // Supersede existing
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM nexaas_memory.facts
     WHERE entity_id = $1 AND fact_key = $2 AND superseded_by IS NULL LIMIT 1`,
    [entity.id, factKey]
  );

  const row = await queryOne<{ id: string }>(
    `INSERT INTO nexaas_memory.facts
     (entity_id, fact_key, fact_value, confidence, source_event_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [entity.id, factKey, factValue, confidence ?? 1.0, sourceEventId ?? null]
  );

  if (existing) {
    await query(`UPDATE nexaas_memory.facts SET superseded_by = $1 WHERE id = $2`,
      [row!.id, existing.id]);
  }

  return row!.id;
}

export async function addRelation(
  fromName: string, relationType: string, toName: string,
  confidence?: number, sourceEventId?: string
): Promise<string> {
  const [fromEntity, toEntity] = await Promise.all([
    queryOne<{ id: string }>(`SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`, [fromName]),
    queryOne<{ id: string }>(`SELECT id FROM nexaas_memory.entities WHERE LOWER(name) = LOWER($1) LIMIT 1`, [toName]),
  ]);
  if (!fromEntity) throw new Error(`Entity not found: ${fromName}`);
  if (!toEntity) throw new Error(`Entity not found: ${toName}`);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO nexaas_memory.relations
     (from_entity_id, to_entity_id, relation_type, confidence, source_event_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [fromEntity.id, toEntity.id, relationType, confidence ?? 1.0, sourceEventId ?? null]
  );
  return row!.id;
}
