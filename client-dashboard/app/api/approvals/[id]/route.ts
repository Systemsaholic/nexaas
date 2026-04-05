import { query, queryOne } from "@/lib/db";
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

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

    // Complete the Trigger.dev wait token via the SDK
    const waitTokenId = (approval.details as any)?.waitTokenId;
    if (waitTokenId) {
      const triggerKey = process.env.TRIGGER_SECRET_KEY ?? "";
      const triggerUrl = process.env.TRIGGER_API_URL ?? "http://localhost:3040";
      const completionData = JSON.stringify({
        approved: action === "approve",
        comment: comment ?? null,
      });

      try {
        // Use the SDK via a one-shot node script to avoid import issues
        await exec("node", ["-e", `
          const { configure } = require("@trigger.dev/sdk/v3");
          const { wait } = require("@trigger.dev/sdk/v3");
          configure({ secretKey: "${triggerKey}", baseURL: "${triggerUrl}" });
          wait.completeToken("${waitTokenId}", ${completionData})
            .then(() => process.exit(0))
            .catch((e) => { console.error(e.message); process.exit(1); });
        `], {
          timeout: 15000,
          cwd: process.env.NEXAAS_ROOT ?? "/opt/nexaas",
          env: { ...process.env, TRIGGER_SECRET_KEY: triggerKey, TRIGGER_API_URL: triggerUrl },
        });
      } catch (e) {
        console.error(`Failed to complete wait token ${waitTokenId}: ${(e as Error).message}`);
      }
    }

    return NextResponse.json({ ok: true, message: action === "approve" ? "Approved!" : "Rejected" });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
