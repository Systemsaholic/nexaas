import { query, queryAll } from "@/lib/db";
import { NextResponse } from "next/server";

const ws = () => process.env.NEXAAS_WORKSPACE ?? "";

// GET: List feedback for this skill
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");

  try {
    const feedback = await queryAll(
      `SELECT * FROM skill_feedback WHERE workspace_id = $1 AND skill_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [ws(), skillId]
    );
    return NextResponse.json({ ok: true, data: feedback });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// POST: Submit feedback (thumbs up/down + optional comment)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const skillId = id.replace("--", "/");
  const { activityId, rating, comment } = await request.json();

  if (!rating || !["positive", "negative"].includes(rating)) {
    return NextResponse.json({ error: "rating must be 'positive' or 'negative'" }, { status: 400 });
  }

  try {
    // Store locally
    await query(
      `INSERT INTO skill_feedback (skill_id, workspace_id, signal, evidence, claude_reflection, collected, created_at)
       VALUES ($1, $2, $3, $4, $5, false, NOW())`,
      [
        skillId,
        ws(),
        rating === "negative" ? "user_feedback" : "user_positive",
        JSON.stringify({ activity_id: activityId, rating }),
        comment || null,
      ]
    );

    // If negative with a comment that sounds generic, flag for orchestrator
    // The scan-workspaces sweep will pick it up and sanitize it
    return NextResponse.json({ ok: true, message: "Feedback recorded. Thank you!" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
