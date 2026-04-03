/**
 * Conversation context store.
 *
 * Persists conversation state across task invocations using thread IDs.
 * TTL cascades: skill override → workspace override → global default (90 days).
 */

import { query, queryOne } from "../db.js";
import { runClaude } from "../../trigger/lib/claude.js";

export interface ConversationContext {
  threadId: string;
  workspaceId: string;
  skillId?: string;
  turns: Array<{ role: string; content: string; timestamp: string }>;
  summary?: string;
  status: string;
}

const DEFAULT_TTL_DAYS = 90;
const DEFAULT_MAX_TURNS = 10;
const TURNS_KEPT_FULL = 5;

export function resolveTtl(
  skillContext?: { threadTtlDays?: number },
  workspaceContext?: { threadTtlDays?: number }
): number {
  return skillContext?.threadTtlDays
    ?? workspaceContext?.threadTtlDays
    ?? DEFAULT_TTL_DAYS;
}

export function resolveMaxTurns(
  skillContext?: { maxTurnsBeforeSummary?: number },
  workspaceContext?: { maxTurnsBeforeSummary?: number }
): number {
  return skillContext?.maxTurnsBeforeSummary
    ?? workspaceContext?.maxTurnsBeforeSummary
    ?? DEFAULT_MAX_TURNS;
}

export async function loadConversationContext(
  threadId: string
): Promise<ConversationContext | null> {
  const row = await queryOne(
    `SELECT thread_id, workspace_id, skill_id, turns, summary, status
     FROM conversation_contexts
     WHERE thread_id = $1 AND status = 'active'`,
    [threadId]
  );

  if (!row) return null;

  return {
    threadId: row.thread_id as string,
    workspaceId: row.workspace_id as string,
    skillId: row.skill_id as string | undefined,
    turns: typeof row.turns === "string" ? JSON.parse(row.turns as string) : (row.turns as any),
    summary: row.summary as string | undefined,
    status: row.status as string,
  };
}

export async function saveConversationContext(
  threadId: string,
  context: {
    workspaceId: string;
    skillId?: string;
    turns: Array<{ role: string; content: string; timestamp: string }>;
    summary?: string;
  }
): Promise<void> {
  await query(
    `INSERT INTO conversation_contexts (thread_id, workspace_id, skill_id, turns, summary, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (thread_id) DO UPDATE SET
       turns = $4,
       summary = $5,
       updated_at = NOW()`,
    [
      threadId,
      context.workspaceId,
      context.skillId || null,
      JSON.stringify(context.turns),
      context.summary || null,
    ]
  );
}

/**
 * Summarize old turns and keep only the last N full turns.
 */
export async function windowContext(
  context: ConversationContext,
  maxTurns: number
): Promise<ConversationContext> {
  if (context.turns.length <= maxTurns) return context;

  const oldTurns = context.turns.slice(0, context.turns.length - TURNS_KEPT_FULL);
  const recentTurns = context.turns.slice(-TURNS_KEPT_FULL);

  const oldText = oldTurns
    .map((t) => `${t.role}: ${t.content.slice(0, 500)}`)
    .join("\n");

  const existingSummary = context.summary ? `Previous summary: ${context.summary}\n\n` : "";

  const result = await runClaude({
    prompt: `Summarize this conversation history in 2-3 sentences. Focus on key decisions, outcomes, and pending items.\n\n${existingSummary}New turns:\n${oldText}`,
    model: "haiku",
    timeoutMs: 30_000,
    mcpServers: [],
  });

  const summary = result.success ? result.output.slice(0, 1000) : context.summary || "";

  return {
    ...context,
    turns: recentTurns,
    summary,
  };
}

/**
 * Clean up expired contexts. Run daily on each client.
 */
export async function cleanupExpiredContexts(ttlDays: number = DEFAULT_TTL_DAYS): Promise<number> {
  const result = await query(
    `DELETE FROM conversation_contexts
     WHERE updated_at < NOW() - ($1 || ' days')::INTERVAL
     RETURNING thread_id`,
    [ttlDays]
  );
  return result.rowCount ?? 0;
}
