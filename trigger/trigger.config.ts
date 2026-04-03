import { defineConfig, tasks } from "@trigger.dev/sdk/v3";
import { escalate } from "../orchestrator/feedback/escalation.js";
import { captureFailure } from "../orchestrator/feedback/collector.js";

/** Tasks excluded from self-healing to prevent loops and noise */
const SKIP_SELF_HEAL = [
  "self-heal",
  "sync-skills",
  "scan-workspaces",
  "receive-escalation",
  "diagnose-failure",
  "check-approvals",
];

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
    },
  },
  dirs: ["tasks", "schedules"],
  onFailure: async ({ payload, error, ctx }) => {
    const taskId = ctx.task.id;
    if (SKIP_SELF_HEAL.some(s => taskId.includes(s))) return;

    const workspaceId = process.env.NEXAAS_WORKSPACE || "unknown";
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Record failure locally
    await captureFailure({
      workspaceId,
      taskId,
      error: errorMsg,
      runId: ctx.run.id,
    }).catch(() => {}); // Don't let DB failure block the handler

    // Attempt self-heal
    const healResult = await tasks.triggerAndWait("self-heal", {
      taskId,
      error: errorMsg,
      runId: ctx.run.id,
    }).catch(() => ({ healed: false }));

    // If self-heal failed, escalate to core
    if (!(healResult as any)?.healed) {
      await escalate({
        workspaceId,
        taskId,
        error: errorMsg,
        selfHealAttempt: "self-heal returned healed: false",
        runId: ctx.run.id,
        timestamp: new Date().toISOString(),
      }).catch(() => {}); // Best-effort — SSH sweep is backup
    }
  },
});
