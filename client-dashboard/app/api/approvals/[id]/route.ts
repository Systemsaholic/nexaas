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
    const approval = await queryOne<{ details: Record<string, unknown> }>(
      `SELECT details FROM pending_approvals WHERE id = $1`,
      [parseInt(id, 10)]
    );

    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    // Update the approval status in DB
    await query(
      `UPDATE pending_approvals SET status = $1, responded_at = NOW() WHERE id = $2`,
      [action === "approve" ? "approved" : "rejected", parseInt(id, 10)]
    );

    // Complete the Trigger.dev wait token
    const waitTokenId = (approval.details as any)?.waitTokenId;
    if (waitTokenId) {
      // Validate token ID format (alphanumeric + underscores only)
      if (!/^waitpoint_[a-z0-9]+$/.test(waitTokenId)) {
        console.error(`Invalid wait token format: ${waitTokenId}`);
      } else {
        try {
          // Use Trigger.dev REST API directly — no shell execution
          const triggerApiUrl = process.env.TRIGGER_API_URL ?? "http://localhost:3040";
          const triggerKey = process.env.TRIGGER_SECRET_KEY ?? "";

          const completionPayload = {
            approved: action === "approve",
            comment: typeof comment === "string" ? comment.slice(0, 500) : null,
          };

          // Trigger.dev v4 token completion via management API
          const res = await fetch(`${triggerApiUrl}/api/v1/waitpoints/tokens/${encodeURIComponent(waitTokenId)}/complete`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${triggerKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(completionPayload),
          });

          if (!res.ok) {
            // Fallback: use the SDK via configure + completeToken
            const { configure } = await import("@trigger.dev/sdk/v3");
            const { wait } = await import("@trigger.dev/sdk/v3");
            configure({ secretKey: triggerKey, baseURL: triggerApiUrl });
            await wait.completeToken(waitTokenId, completionPayload);
          }
        } catch (e) {
          console.error(`Failed to complete wait token ${waitTokenId}: ${(e as Error).message}`);
          // Don't fail the approval — token may have expired
        }
      }
    }

    return NextResponse.json({ ok: true, message: action === "approve" ? "Approved!" : "Rejected" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Failed to process approval" }, { status: 500 });
  }
}
