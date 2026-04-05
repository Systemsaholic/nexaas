import { queryAll } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") ?? "50", 10);
  const ws = process.env.NEXAAS_WORKSPACE ?? "";

  try {
    const activity = await queryAll(
      `SELECT * FROM activity_log WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ws, limit]
    );
    return NextResponse.json({ ok: true, data: activity });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
