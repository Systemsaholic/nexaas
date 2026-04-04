import { queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

// Global usage summary across all workspaces (for billing overview)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") ?? "30", 10);

  try {
    const byWorkspace = await queryAll(
      `SELECT
         workspace,
         COUNT(*) as calls,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(input_tokens + output_tokens) as total_tokens,
         SUM(cost_usd) as total_cost
       FROM token_usage
       WHERE created_at > NOW() - INTERVAL '1 day' * $1
       GROUP BY workspace
       ORDER BY total_cost DESC`,
      [days]
    );

    return ok({ byWorkspace, days });
  } catch (e) {
    return err(`Failed to load usage: ${(e as Error).message}`, 500);
  }
}
