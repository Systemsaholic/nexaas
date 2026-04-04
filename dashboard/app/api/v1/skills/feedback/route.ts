import { queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

export async function GET() {
  try {
    const feedback = await queryAll(
      `SELECT id, skill_id, workspace_id, signal, claude_reflection, created_at
       FROM skill_feedback
       ORDER BY created_at DESC LIMIT 50`
    );
    return ok(feedback);
  } catch (e) {
    return err(`Failed to load feedback: ${(e as Error).message}`, 500);
  }
}
