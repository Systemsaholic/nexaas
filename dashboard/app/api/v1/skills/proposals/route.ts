import { queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  try {
    let sql = `SELECT * FROM skill_proposals ORDER BY created_at DESC LIMIT 50`;
    const params: unknown[] = [];

    if (status) {
      sql = `SELECT * FROM skill_proposals WHERE status = $1 ORDER BY created_at DESC LIMIT 50`;
      params.push(status);
    }

    const proposals = await queryAll(sql, params);
    return ok(proposals);
  } catch (e) {
    return err(`Failed to load proposals: ${(e as Error).message}`, 500);
  }
}
