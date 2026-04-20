/**
 * Outbox relay — bridges Postgres intent rows to BullMQ jobs.
 *
 * Polls nexaas_memory.outbox for unprocessed intent rows and enqueues
 * the corresponding BullMQ jobs. Ensures transactional consistency
 * between Postgres state updates and Redis job enqueuing.
 *
 * If the relay crashes, unprocessed rows remain and retry on next startup.
 */

import { sql } from "@nexaas/palace";
import { enqueueSkillStep, enqueueDelayedSkillStep, type SkillJobData } from "./queues.js";

interface OutboxRow {
  id: number;
  workspace: string;
  intent_type: string;
  payload: Record<string, unknown>;
}

async function processOutboxRow(row: OutboxRow): Promise<void> {
  const payload = row.payload;

  switch (row.intent_type) {
    case "enqueue_job": {
      // manifest_path is an extension field used by the BullMQ worker to
      // dispatch ai-skill / shell-skill branches (versus pillar pipeline
      // fallback). Approval-resolver's handler-dispatch path (#53) writes
      // this; outbox relay forwards it to the job data as-is.
      const jobData: Record<string, unknown> = {
        workspace: row.workspace,
        runId: payload.run_id as string,
        skillId: payload.skill_id as string,
        skillVersion: payload.skill_version as string | undefined,
        stepId: payload.step_id as string,
        triggerType: payload.trigger_type as string ?? "event",
        triggerPayload: payload.trigger_payload as Record<string, unknown> | undefined,
        resumedWith: payload.resumed_with as Record<string, unknown> | undefined,
        parentRunId: payload.parent_run_id as string | undefined,
        depth: payload.depth as number | undefined,
      };
      if (typeof payload.manifest_path === "string") {
        jobData.manifestPath = payload.manifest_path;
      }
      await enqueueSkillStep(jobData as unknown as Parameters<typeof enqueueSkillStep>[0]);
      break;
    }

    case "enqueue_delayed": {
      const deferUntil = new Date(payload.defer_until as string);
      const delayMs = Math.max(0, deferUntil.getTime() - Date.now());

      await enqueueDelayedSkillStep(
        {
          workspace: row.workspace,
          runId: payload.run_id as string,
          skillId: payload.skill_id as string,
          stepId: payload.step_id as string,
          triggerType: "defer",
        },
        delayMs,
      );
      break;
    }

    case "cancel_job": {
      // Future: cancel a specific BullMQ job by ID
      break;
    }

    default:
      console.warn(`Unknown outbox intent_type: ${row.intent_type}`);
  }
}

export async function pollOutbox(): Promise<number> {
  const rows = await sql<OutboxRow>(
    `SELECT id, workspace, intent_type, payload
     FROM nexaas_memory.outbox
     WHERE processed_at IS NULL
     ORDER BY created_at ASC
     LIMIT 100`,
  );

  let processed = 0;

  for (const row of rows) {
    try {
      await processOutboxRow(row);

      await sql(
        `UPDATE nexaas_memory.outbox SET processed_at = now() WHERE id = $1`,
        [row.id],
      );

      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await sql(
        `UPDATE nexaas_memory.outbox SET error = $2 WHERE id = $1`,
        [row.id, message],
      );
    }
  }

  return processed;
}

let _running = false;
let _interval: ReturnType<typeof setInterval> | null = null;
let _polling = false;        // reentrance guard
let _backoffUntil = 0;       // ms since epoch; skip polls while in backoff
let _consecutiveFailures = 0;
const MAX_BACKOFF_MS = 60_000;

export function startOutboxRelay(pollIntervalMs: number = 1000): void {
  if (_running) return;
  _running = true;

  _interval = setInterval(async () => {
    // Reentrance guard — if a previous poll is still running (slow DB,
    // big batch), don't start a second one. Prevents concurrent DB
    // pressure and overlapping UPDATEs on the same rows.
    if (_polling) return;
    // Exponential backoff after repeated failures so we don't spam
    // errors every second when PG/Redis is down. Reset on first success.
    if (Date.now() < _backoffUntil) return;

    _polling = true;
    try {
      await pollOutbox();
      _consecutiveFailures = 0;
    } catch (err) {
      _consecutiveFailures++;
      const backoff = Math.min(MAX_BACKOFF_MS, pollIntervalMs * Math.pow(2, _consecutiveFailures));
      _backoffUntil = Date.now() + backoff;
      console.error(
        `Outbox relay error (${_consecutiveFailures} in a row, next poll in ${Math.round(backoff / 1000)}s):`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      _polling = false;
    }
  }, pollIntervalMs);

  process.on("SIGTERM", stopOutboxRelay);
  process.on("SIGINT", stopOutboxRelay);
}

export function stopOutboxRelay(): void {
  _running = false;
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
