import { queryAll } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "pending";
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const approvals = await queryAll(
      `SELECT * FROM pending_approvals WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 50`,
      [ws, status]
    );
    return NextResponse.json({ ok: true, data: approvals });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
