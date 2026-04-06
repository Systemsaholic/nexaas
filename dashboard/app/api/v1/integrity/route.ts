import { queryAll } from "@/lib/db";
import { ok, err } from "@/lib/api-response";

// GET: Latest integrity check results for all instances
export async function GET() {
  try {
    const results = await queryAll(
      `SELECT severity, message, details, created_at
       FROM ops_alerts
       WHERE category = 'integrity'
       ORDER BY created_at DESC
       LIMIT 50`
    );

    // Parse details JSON and group by workspace
    const byWorkspace = new Map<string, any>();
    for (const row of results) {
      const details = typeof (row as any).details === "string"
        ? JSON.parse((row as any).details)
        : (row as any).details;

      if (details?.workspace && !byWorkspace.has(details.workspace)) {
        byWorkspace.set(details.workspace, {
          ...(row as any),
          details,
        });
      }
    }

    return ok({
      results: Array.from(byWorkspace.values()),
      lastRun: results.length > 0 ? (results[0] as any).created_at : null,
    });
  } catch (e) {
    return err(`Failed to load integrity results: ${(e as Error).message}`, 500);
  }
}

// POST: Trigger an integrity check now
export async function POST() {
  try {
    // Trigger via the orchestrator's Trigger.dev
    const triggerKey = process.env.TRIGGER_SECRET_KEY ?? "";
    const triggerUrl = process.env.TRIGGER_API_URL ?? "http://localhost:3040";

    const res = await fetch(`${triggerUrl}/api/v1/tasks/integrity-check/trigger`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
    });

    const result = await res.json();
    return ok({ message: "Integrity check triggered", runId: result.id });
  } catch (e) {
    return err(`Failed to trigger integrity check: ${(e as Error).message}`, 500);
  }
}
