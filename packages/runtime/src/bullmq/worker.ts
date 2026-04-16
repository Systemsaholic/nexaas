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
import { runTracker } from "../run-tracker.js";
import { appendWal } from "@nexaas/palace";
import type { SkillJobData } from "./queues.js";
import { readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";

let _worker: Worker | null = null;

export function startWorker(workspaceId: string, concurrency: number = 5): Worker {
  if (_worker) return _worker;

  const queueName = `nexaas-skills-${workspaceId}`;

  _worker = new Worker(
    queueName,
    async (job: Job<SkillJobData>) => {
      const data = job.data;

      // Create the run record if this is the first step
      if (data.stepId === "init" || !data.resumedWith) {
        try {
          await runTracker.createRun({
            runId: data.runId,
            workspace: data.workspace,
            skillId: data.skillId,
            skillVersion: data.skillVersion,
            triggerType: data.triggerType,
            triggerPayload: data.triggerPayload,
            parentRunId: data.parentRunId,
            depth: data.depth,
          });
        } catch (err) {
          // Run might already exist (resumed from waitpoint)
          const pgErr = err as { code?: string };
          if (pgErr.code !== "23505") throw err;
        }
      }

      // Check if this is a shell skill (has manifestPath) or an AI skill
      const jobData = data as SkillJobData & { manifestPath?: string };
      if (jobData.manifestPath) {
        const manifestContent = readFileSync(jobData.manifestPath, "utf-8");
        const manifest = yamlLoad(manifestContent) as ShellSkillManifest;

        if (manifest.execution?.type === "shell") {
          await runShellSkill(data.workspace, manifest);
          return;
        }
      }

      // Execute the pillar pipeline (AI skills)
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
      workspace: job.data.workspace,
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
      workspace: job.data.workspace,
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
    if (_worker) {
      await _worker.close();
      _worker = null;
    }
    process.exit(0);
  });

  process.on("SIGINT", async () => {
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
