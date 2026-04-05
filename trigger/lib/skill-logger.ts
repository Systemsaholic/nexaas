/**
 * Shared logging for skill execution — activity_log and token_usage.
 *
 * Uses a single shared pg pool. Every skill execution should call
 * logSkillActivity() and logSkillTokenUsage() after completion.
 */

import pg from "pg";
import { logger } from "@trigger.dev/sdk/v3";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

export async function logSkillActivity(
  workspaceId: string,
  skillId: string,
  action: string,
  summary: string,
  tagRoute: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO activity_log (workspace_id, skill_id, action, summary, details, tag_route, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [workspaceId, skillId, action, summary, JSON.stringify(details), tagRoute]
    );
  } catch (e) {
    logger.warn(`Failed to log activity: ${(e as Error).message}`);
  }
}

export async function logSkillTokenUsage(
  workspaceId: string,
  skillId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  try {
    // Approximate costs per model ($/MTok)
    const costs: Record<string, [number, number]> = {
      "claude-sonnet-4-20250514": [3, 15],
      "claude-haiku-4-5-20251001": [0.8, 4],
    };
    const [inputCost, outputCost] = costs[model] ?? [3, 15];
    const costUsd = (inputTokens * inputCost + outputTokens * outputCost) / 1_000_000;

    await pool.query(
      `INSERT INTO token_usage (workspace, agent, source, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, $2, 'skill', $3, $4, $5, $6, NOW())`,
      [workspaceId, skillId, model, inputTokens, outputTokens, costUsd]
    );
  } catch (e) {
    logger.warn(`Failed to log token usage: ${(e as Error).message}`);
  }
}
