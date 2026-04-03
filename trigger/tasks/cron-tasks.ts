/**
 * Shell-based cron task definitions.
 *
 * Pattern: define a task + a schedules.task wrapper.
 * Add workspace-specific cron tasks below the template.
 */

import { task, schedules, logger, tags as tdTags } from "@trigger.dev/sdk/v3";
import { runShell, type ShellResult } from "../lib/shell.js";
import { domainTag } from "../lib/domain-tags.js";

const CRON_QUEUE = {
  name: "cron-tasks",
  concurrencyLimit: 2,
} as const;

const CRON_RETRY = {
  maxAttempts: 2,
  factor: 2,
  minTimeoutInMs: 10_000,
  maxTimeoutInMs: 60_000,
} as const;

export function assertSuccess(result: ShellResult, label: string): void {
  if (!result.success) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`
    );
  }
}

// Add workspace-specific cron tasks below.
// Pattern: task definition + schedules.task wrapper
//
// export const myTask = task({
//   id: "my-task",
//   queue: CRON_QUEUE,
//   retry: CRON_RETRY,
//   maxDuration: 600,
//   run: async () => {
//     await tdTags.add(domainTag("operations"));
//     const result = await runShell({ command: "bash scripts/my-script.sh" });
//     assertSuccess(result, "my-task");
//     return { durationMs: result.durationMs };
//   },
// });
//
// export const myTaskSchedule = schedules.task({
//   id: "my-task-schedule",
//   cron: "0 6 * * *",
//   maxDuration: 60,
//   run: async () => { await myTask.trigger(); },
// });
