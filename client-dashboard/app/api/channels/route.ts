import { queryAll, query } from "@/lib/db";
import { NextResponse } from "next/server";

const ws = () => process.env.NEXAAS_WORKSPACE ?? "";

// GET: List channels + user preferences
export async function GET() {
  try {
    const channels = await queryAll(
      `SELECT * FROM channel_registry WHERE workspace_id = $1 AND active = true ORDER BY display_name`,
      [ws()]
    );

    const preferences = await queryAll(
      `SELECT * FROM user_channel_preferences WHERE workspace_id = $1`,
      [ws()]
    );

    return NextResponse.json({ ok: true, data: { channels, preferences } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// POST: Set user channel preference
export async function POST(request: Request) {
  const { userEmail, preferenceType, channelId } = await request.json();

  if (!userEmail || !preferenceType || !channelId) {
    return NextResponse.json({ error: "userEmail, preferenceType, and channelId required" }, { status: 400 });
  }

  try {
    await query(
      `INSERT INTO user_channel_preferences (workspace_id, user_email, preference_type, channel_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, user_email, preference_type) DO UPDATE SET channel_id = $4`,
      [ws(), userEmail, preferenceType, channelId]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
