/**
 * Failure escalation — webhook push to core VPS.
 *
 * When self-heal fails on a client, fires a lightweight POST
 * to the core's escalation endpoint. Zero tokens — just HTTP.
 * Falls back gracefully if core is unreachable.
 */

import { logger } from "@trigger.dev/sdk/v3";

const CORE_WEBHOOK_URL = process.env.NEXAAS_CORE_WEBHOOK_URL;

export interface EscalationPayload {
  workspaceId: string;
  skillId?: string;
  taskId: string;
  error: string;
  selfHealAttempt?: string;
  runId: string;
  timestamp: string;
}

export async function escalate(payload: EscalationPayload): Promise<boolean> {
  if (!CORE_WEBHOOK_URL) {
    logger.warn("NEXAAS_CORE_WEBHOOK_URL not configured — escalation skipped");
    return false;
  }

  try {
    const resp = await fetch(CORE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.ok) {
      logger.info(`Escalated failure to core: ${payload.taskId}`);
      return true;
    }

    logger.warn(`Escalation failed (${resp.status}): ${payload.taskId}`);
    return false;
  } catch (err) {
    logger.warn(`Escalation webhook unreachable: ${err}`);
    return false;
  }
}
