/**
 * Conversation context store — Phase 2.
 *
 * Will persist conversation state across task invocations using
 * thread IDs (from email Message-ID, webhook correlation ID, etc.).
 */

export interface ConversationContext {
  threadId: string;
  workspaceId: string;
  skillId?: string;
  turns: Array<{ role: string; content: string; timestamp: Date }>;
  summary?: string;
}

export async function loadConversationContext(
  _threadId: string
): Promise<ConversationContext | null> {
  // Phase 2: implement with Postgres
  return null;
}

export async function saveConversationContext(
  _threadId: string,
  _context: Partial<ConversationContext>
): Promise<void> {
  // Phase 2: implement with Postgres
}
