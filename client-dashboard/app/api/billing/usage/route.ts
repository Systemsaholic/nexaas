import { queryOne, queryAll } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const summary = await queryOne(
      `SELECT
         COUNT(*) as total_calls,
         COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
         COALESCE(SUM(cost_usd), 0) as total_cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > DATE_TRUNC('month', CURRENT_DATE)`,
      [ws]
    );

    const byModel = await queryAll(
      `SELECT model, COUNT(*) as calls, SUM(input_tokens + output_tokens) as tokens, SUM(cost_usd) as cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > DATE_TRUNC('month', CURRENT_DATE)
       GROUP BY model ORDER BY cost DESC`,
      [ws]
    );

    const bySkill = await queryAll(
      `SELECT COALESCE(agent, source) as skill, COUNT(*) as calls, SUM(input_tokens + output_tokens) as tokens, SUM(cost_usd) as cost
       FROM token_usage
       WHERE workspace = $1 AND created_at > DATE_TRUNC('month', CURRENT_DATE)
       GROUP BY COALESCE(agent, source) ORDER BY cost DESC`,
      [ws]
    );

    return NextResponse.json({ ok: true, data: { summary, byModel, bySkill } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
