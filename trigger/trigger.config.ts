import { defineConfig, tasks } from "@trigger.dev/sdk/v3";

/** Tasks excluded from self-healing to prevent loops and noise */
const SKIP_SELF_HEAL = [
  "self-heal",
  "sync-skills",
];

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  runtime: "node",
  logLevel: "log",
  maxDuration: 3600, // 60 minutes — covers chained pipelines
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
    await tasks.trigger("self-heal", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
      runId: ctx.run.id,
    });
  },
});
