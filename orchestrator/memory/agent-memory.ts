/**
 * Agent Memory — persistent per-department state.
 *
 * Architecture Guide v4 — three-table model:
 * - activity_log: what happened (immutable audit trail)
 * - conversation_contexts: thread memory (expires via TTL)
 * - agent_memory: department memory (persistent, grows over time)
 *
 * This module manages the agent_memory table.
 */

import { query, queryAll } from "../db.js";

export interface MemoryEntry {
  department: string;
  memoryType: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

/**
 * Load all memory for a department.
 */
export async function loadDepartmentMemory(
  workspaceId: string,
  department: string,
): Promise<MemoryEntry[]> {
  const rows = await queryAll(
    `SELECT department, memory_type, key, value, updated_at
     FROM agent_memory WHERE workspace_id = $1 AND department = $2
     ORDER BY updated_at DESC`,
    [workspaceId, department]
  );
  return rows.map((r: any) => ({
    department: r.department,
    memoryType: r.memory_type,
    key: r.key,
    value: r.value,
    updatedAt: r.updated_at,
  }));
}

/**
 * Load specific memory entries by type.
 */
export async function loadMemoryByType(
  workspaceId: string,
  department: string,
  memoryType: string,
): Promise<MemoryEntry[]> {
  const rows = await queryAll(
    `SELECT department, memory_type, key, value, updated_at
     FROM agent_memory WHERE workspace_id = $1 AND department = $2 AND memory_type = $3
     ORDER BY key`,
    [workspaceId, department, memoryType]
  );
  return rows.map((r: any) => ({
    department: r.department,
    memoryType: r.memory_type,
    key: r.key,
    value: r.value,
    updatedAt: r.updated_at,
  }));
}

/**
 * Upsert a memory entry.
 */
export async function setMemory(
  workspaceId: string,
  department: string,
  memoryType: string,
  key: string,
  value: unknown,
): Promise<void> {
  await query(
    `INSERT INTO agent_memory (workspace_id, department, memory_type, key, value, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id, department, memory_type, key)
     DO UPDATE SET value = $5, updated_at = NOW()`,
    [workspaceId, department, memoryType, key, JSON.stringify(value)]
  );
}

/**
 * Delete a memory entry.
 */
export async function deleteMemory(
  workspaceId: string,
  department: string,
  memoryType: string,
  key: string,
): Promise<void> {
  await query(
    `DELETE FROM agent_memory WHERE workspace_id = $1 AND department = $2 AND memory_type = $3 AND key = $4`,
    [workspaceId, department, memoryType, key]
  );
}

/**
 * Get open items for a department (convenience method).
 */
export async function getOpenItems(
  workspaceId: string,
  department: string,
): Promise<unknown[]> {
  const entries = await loadMemoryByType(workspaceId, department, "open_items");
  if (entries.length === 0) return [];
  const first = entries[0];
  return Array.isArray(first.value) ? first.value : [];
}

/**
 * Get last session summary for a department.
 */
export async function getLastSessionSummary(
  workspaceId: string,
  department: string,
): Promise<{ summary: string; date: string } | null> {
  const entries = await loadMemoryByType(workspaceId, department, "session_summary");
  if (entries.length === 0) return null;
  const val = entries[0].value as any;
  return { summary: val?.summary ?? "", date: val?.date ?? "" };
}
