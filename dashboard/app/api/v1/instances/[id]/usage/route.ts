import { queryAll, queryOne } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") ?? "30", 10);

  try {
    // Summary totals
    const summary = await queryOne(
      `SELECT
         COUNT(*) as total_calls,
         COALESCE(SUM(input_tokens), 0) as total_input,
         COALESCE(SUM(output_tokens), 0) as total_output,
         COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
         COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
         COALESCE(SUM(cost_usd), 0) as total_cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > NOW() - INTERVAL '1 day' * $2`,
      [id, days]
    );

    // Daily breakdown
    const daily = await queryAll(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as calls,
         SUM(input_tokens + output_tokens) as tokens,
         SUM(cost_usd) as cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [id, days]
    );

    // Per-model breakdown
    const byModel = await queryAll(
      `SELECT
         model,
         COUNT(*) as calls,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(cost_usd) as cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY model
       ORDER BY cost DESC`,
      [id, days]
    );

    // Per-skill/agent breakdown
    const byAgent = await queryAll(
      `SELECT
         COALESCE(agent, source) as agent,
         COUNT(*) as calls,
         SUM(input_tokens + output_tokens) as tokens,
         SUM(cost_usd) as cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
       GROUP BY COALESCE(agent, source)
       ORDER BY cost DESC`,
      [id, days]
    );

    return ok({ summary, daily, byModel, byAgent, days });
  } catch (e) {
    return err(`Failed to load usage: ${(e as Error).message}`, 500);
  }
}
