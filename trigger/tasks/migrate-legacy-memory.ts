/**
 * One-time migration: moves data from legacy memory tables into
 * the new nexaas_memory schema.
 *
 * Sources:
 * - agent_memory → nexaas_memory.events (event_type='context')
 * - conversation_contexts → nexaas_memory.events (event_type='context')
 * - activity_log → nexaas_memory.events (event_type='action')
 *
 * Idempotent via content_hash dedup.
 */

import { task, logger } from "@trigger.dev/sdk/v3";
import { query, queryAll } from "../../orchestrator/db.js";
import { storeEvent } from "../../orchestrator/memory/store.js";

export const migrateLegacyMemory = task({
  id: "migrate-legacy-memory",
  queue: { name: "orchestrator", concurrencyLimit: 1 },
  maxDuration: 600,
  run: async () => {
    let migrated = { agentMemory: 0, conversations: 0, activityLog: 0 };

    // 1. Migrate agent_memory → events
    try {
      const memories = await queryAll<{
        workspace_id: string; department: string; memory_type: string;
        key: string; value: unknown; updated_at: string;
      }>(`SELECT * FROM agent_memory ORDER BY updated_at`);

      for (const m of memories) {
        await storeEvent({
          agentId: `dept/${m.department}`,
          eventType: "context",
          content: `[Legacy Memory] ${m.memory_type}/${m.key}: ${JSON.stringify(m.value)}`,
          metadata: {
            source: "legacy_migration",
            original_table: "agent_memory",
            workspace_id: m.workspace_id,
            department: m.department,
            memory_type: m.memory_type,
            key: m.key,
          },
        });
        migrated.agentMemory++;
      }
      logger.info(`Migrated ${migrated.agentMemory} agent_memory rows`);
    } catch (e) {
      logger.warn(`agent_memory migration: ${(e as Error).message}`);
    }

    // 2. Migrate conversation_contexts → events
    try {
      const contexts = await queryAll<{
        thread_id: string; workspace_id: string; skill_id: string;
        turns: unknown; summary: string; updated_at: string;
      }>(`SELECT * FROM conversation_contexts WHERE status = 'active' ORDER BY updated_at`);

      for (const c of contexts) {
        const turns = Array.isArray(c.turns) ? c.turns : [];
        const content = c.summary
          ? `[Legacy Conversation] Thread ${c.thread_id}\nSummary: ${c.summary}\nTurns: ${turns.length}`
          : `[Legacy Conversation] Thread ${c.thread_id}\nTurns: ${JSON.stringify(turns).slice(0, 5000)}`;

        await storeEvent({
          agentId: c.skill_id ? `skill/${c.skill_id}` : "system",
          eventType: "context",
          content,
          metadata: {
            source: "legacy_migration",
            original_table: "conversation_contexts",
            workspace_id: c.workspace_id,
            thread_id: c.thread_id,
            turn_count: turns.length,
          },
        });
        migrated.conversations++;
      }
      logger.info(`Migrated ${migrated.conversations} conversation_contexts rows`);
    } catch (e) {
      logger.warn(`conversation_contexts migration: ${(e as Error).message}`);
    }

    // 3. Migrate activity_log → events
    try {
      const activities = await queryAll<{
        workspace_id: string; skill_id: string; action: string;
        summary: string; details: unknown; tag_route: string; created_at: string;
      }>(`SELECT * FROM activity_log ORDER BY created_at`);

      for (const a of activities) {
        await storeEvent({
          agentId: a.skill_id ? `skill/${a.skill_id}` : "system",
          eventType: "action",
          content: `[Legacy Activity] ${a.action}: ${a.summary}`,
          metadata: {
            source: "legacy_migration",
            original_table: "activity_log",
            workspace_id: a.workspace_id,
            action: a.action,
            tag_route: a.tag_route,
            details: a.details,
          },
        });
        migrated.activityLog++;
      }
      logger.info(`Migrated ${migrated.activityLog} activity_log rows`);
    } catch (e) {
      logger.warn(`activity_log migration: ${(e as Error).message}`);
    }

    // Store migration complete sentinel
    await storeEvent({
      agentId: "system",
      eventType: "context",
      content: `Legacy memory migration complete: ${JSON.stringify(migrated)}`,
      metadata: { source: "legacy_migration", ...migrated },
    });

    logger.info(`Migration complete: ${JSON.stringify(migrated)}`);
    return migrated;
  },
});
