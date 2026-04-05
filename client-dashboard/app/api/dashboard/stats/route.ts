import { queryOne } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const activeSkills = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM workspace_skills WHERE workspace_id = $1 AND active = true`,
      [ws]
    );

    const pendingApprovals = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM pending_approvals WHERE workspace_id = $1 AND status = 'pending'`,
      [ws]
    );

    const recentActivity = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM activity_log WHERE workspace_id = $1 AND created_at > CURRENT_DATE`,
      [ws]
    );

    const tokensThisMonth = await queryOne<{ total: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM token_usage
       WHERE workspace = $1 AND created_at > DATE_TRUNC('month', CURRENT_DATE)`,
      [ws]
    );

    return NextResponse.json({
      ok: true,
      data: {
        activeSkills: parseInt(activeSkills?.count ?? "0", 10),
        pendingApprovals: parseInt(pendingApprovals?.count ?? "0", 10),
        recentActivity: parseInt(recentActivity?.count ?? "0", 10),
        tokensThisMonth: parseInt(tokensThisMonth?.total ?? "0", 10),
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
