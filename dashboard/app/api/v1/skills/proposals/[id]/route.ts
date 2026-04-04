import { query, queryOne } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await request.json();

  if (action !== "approve" && action !== "reject") {
    return err("Action must be 'approve' or 'reject'");
  }

  try {
    const proposal = await queryOne(
      `SELECT * FROM skill_proposals WHERE id = $1`,
      [parseInt(id, 10)]
    );

    if (!proposal) return notFound("Proposal");

    const newStatus = action === "approve" ? "reviewed" : "rejected";
    await query(
      `UPDATE skill_proposals SET status = $1, reviewed_at = NOW() WHERE id = $2`,
      [newStatus, parseInt(id, 10)]
    );

    return ok({ id: parseInt(id, 10), status: newStatus });
  } catch (e) {
    return err(`Failed to update proposal: ${(e as Error).message}`, 500);
  }
}
