/**
 * BullMQ worker — processes skill step jobs through the pillar pipeline.
 *
 * Uses sandboxed processors for isolation: each job runs in a child process
 * with clean cgroup inheritance. Worker crashes kill the child, not the parent.
 * No setsid, no reparenting to PID 1, no orphan accumulation.
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnectionOpts } from "./connection.js";
import { runSkillStep } from "../pipeline.js";
import { runShellSkill, type ShellSkillManifest } from "../shell-skill.js";
import { runAiSkill, type AiSkillManifest } from "../ai-skill.js";
import { runTracker } from "../run-tracker.js";
import { appendWal } from "@nexaas/palace";
import type { SkillJobData } from "./queues.js";
import { isRateLimitError, extractCooldownMs, pauseQueueFor } from "./rate-limit.js";
import { startHeartbeatLoop, stopHeartbeatLoop } from "../fleet/heartbeat.js";
import { readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { randomUUID } from "crypto";

let _worker: Worker | null = null;

export function startWorker(workspaceId: string, concurrency: number = 5): Worker {
  if (_worker) return _worker;

  // Fire the fleet heartbeat loop alongside the worker. Silent no-op if
  // NEXAAS_FLEET_ENDPOINT / NEXAAS_FLEET_TOKEN aren't set.
  startHeartbeatLoop();

  const queueName = `nexaas-skills-${workspaceId}`;

  _worker = new Worker(
    queueName,
    async (job: Job<SkillJobData>) => {
      const data = job.data;

      // Ensure workspace is set — scheduler templates may not persist data
      if (!data.workspace) {
        data.workspace = workspaceId;
      }

      // Generate a runId if not provided (cron-triggered jobs don't have one)
      if (!data.runId) {
        data.runId = randomUUID();
      }

      // Route to the right executor based on manifest execution type
      // Shell/AI skill executors create their own run records
      const jobData = data as SkillJobData & { manifestPath?: string };
      if (jobData.manifestPath) {
        const manifestContent = readFileSync(jobData.manifestPath, "utf-8");
        const manifest = yamlLoad(manifestContent) as Record<string, unknown>;
        const execType = (manifest.execution as Record<string, unknown>)?.type;

        if (execType === "shell") {
          await runShellSkill(data.workspace, manifest as unknown as ShellSkillManifest);
          return;
        }

        if (execType === "ai-skill") {
          try {
            await runAiSkill(data.workspace, manifest as unknown as AiSkillManifest, jobData.manifestPath);
          } catch (err) {
            if (isRateLimitError(err)) {
              const cooldownMs = extractCooldownMs(err);
              await pauseQueueFor(
                data.workspace,
                cooldownMs,
                `anthropic-429 on skill ${data.skillId}`,
              );
            }
            throw err;
          }
          return;
        }
      }

      // Pillar pipeline path — create run record here (shell/AI executors create their own)
      if (!data.resumedWith) {
        try {
          await runTracker.createRun({
            runId: data.runId,
            workspace: data.workspace,
            skillId: data.skillId,
            skillVersion: data.skillVersion,
            triggerType: data.triggerType ?? "manual",
            triggerPayload: data.triggerPayload,
            parentRunId: data.parentRunId,
            depth: data.depth,
          });
        } catch (err) {
          const pgErr = err as { code?: string };
          if (pgErr.code !== "23505") throw err;
        }
      }

      await runSkillStep({
        workspace: data.workspace,
        runId: data.runId,
        skillId: data.skillId,
        skillVersion: data.skillVersion,
        stepId: data.stepId,
        resumedWith: data.resumedWith,
      });
    },
    {
      ...getRedisConnectionOpts(),
      concurrency,
      limiter: {
        max: concurrency,
        duration: 1000,
      },
    },
  );

  _worker.on("completed", async (job: Job<SkillJobData>) => {
    await appendWal({
      workspace: job.data.workspace ?? workspaceId,
      op: "job_completed",
      actor: "bullmq-worker",
      payload: {
        job_id: job.id,
        run_id: job.data.runId,
        step_id: job.data.stepId,
        skill_id: job.data.skillId,
        duration_ms: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
      },
    });
  });

  _worker.on("failed", async (job: Job<SkillJobData> | undefined, err: Error) => {
    if (!job) return;

    await appendWal({
      workspace: job.data.workspace ?? workspaceId,
      op: "job_failed",
      actor: "bullmq-worker",
      payload: {
        job_id: job.id,
        run_id: job.data.runId,
        step_id: job.data.stepId,
        skill_id: job.data.skillId,
        error: err.message,
        attempt: job.attemptsMade,
      },
    });
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    stopHeartbeatLoop();
    if (_worker) {
      await _worker.close();
      _worker = null;
    }
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    stopHeartbeatLoop();
    if (_worker) {
      await _worker.close();
      _worker = null;
    }
    process.exit(0);
  });

  return _worker;
}

export function getWorker(): Worker | null {
  return _worker;
}
