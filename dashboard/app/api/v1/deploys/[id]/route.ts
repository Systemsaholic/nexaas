import { queryOne } from "@/lib/db";
import { ok, err, notFound } from "@/lib/api-response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const run = await queryOne(
      `SELECT * FROM deploy_runs WHERE id = $1`,
      [parseInt(id, 10)]
    );

    if (!run) return notFound("Deploy run");
    return ok(run);
  } catch (e) {
    return err(`Failed to fetch deploy: ${(e as Error).message}`, 500);
  }
}
