import { query, queryOne } from "@/lib/db";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action, comment } = await request.json();

  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "Action must be approve or reject" }, { status: 400 });
  }

  try {
    // Get the approval record to find the wait token
    const approval = await queryOne<{ details: Record<string, unknown> }>(
      `SELECT details FROM pending_approvals WHERE id = $1`,
      [parseInt(id, 10)]
    );

    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    // Update the approval status
    await query(
      `UPDATE pending_approvals SET status = $1, responded_at = NOW() WHERE id = $2`,
      [action === "approve" ? "approved" : "rejected", parseInt(id, 10)]
    );

    // Complete the Trigger.dev wait token to resume the paused task
    const waitTokenId = (approval.details as any)?.waitTokenId;
    if (waitTokenId) {
      try {
        // Call the Trigger.dev API to complete the token
        const triggerApiUrl = process.env.TRIGGER_API_URL ?? "http://localhost:3040";
        const triggerKey = process.env.TRIGGER_SECRET_KEY ?? "";

        const res = await fetch(`${triggerApiUrl}/api/v1/waitpoints/tokens/${waitTokenId}/complete`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${triggerKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            approved: action === "approve",
            comment: comment ?? null,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          console.error(`Failed to complete wait token ${waitTokenId}: ${errText}`);
        }
      } catch (e) {
        console.error(`Error completing wait token: ${(e as Error).message}`);
        // Don't fail the approval — the token may have already expired
      }
    }

    return NextResponse.json({ ok: true, message: `${action === "approve" ? "Approved" : "Rejected"}` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
