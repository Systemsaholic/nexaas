/**
 * BullMQ queue definitions for skill execution.
 *
 * One queue per workspace for isolation. Each queue has concurrency limits
 * to prevent one runaway skill from starving others.
 */

import { Queue, type QueueOptions } from "bullmq";
import { getRedisConnectionOpts } from "./connection.js";

const _queues = new Map<string, Queue>();

export function getSkillQueue(workspaceId: string): Queue {
  const queueName = `nexaas:skills:${workspaceId}`;

  if (!_queues.has(queueName)) {
    const opts: QueueOptions = {
      ...getRedisConnectionOpts(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: {
          age: 86400 * 7, // Keep completed jobs for 7 days
          count: 1000,
        },
        removeOnFail: {
          age: 86400 * 30, // Keep failed jobs for 30 days
        },
      },
    };

    _queues.set(queueName, new Queue(queueName, opts));
  }

  return _queues.get(queueName)!;
}

export interface SkillJobData {
  workspace: string;
  runId: string;
  skillId: string;
  skillVersion?: string;
  stepId: string;
  triggerType: string;
  triggerPayload?: Record<string, unknown>;
  resumedWith?: Record<string, unknown>;
  parentRunId?: string;
  depth?: number;
}

export async function enqueueSkillStep(data: SkillJobData): Promise<string> {
  const queue = getSkillQueue(data.workspace);

  const job = await queue.add("skill-step", data, {
    jobId: `${data.runId}:${data.stepId}`,
  });

  return job.id!;
}

export async function enqueueDelayedSkillStep(
  data: SkillJobData,
  delayMs: number,
): Promise<string> {
  const queue = getSkillQueue(data.workspace);

  const job = await queue.add("skill-step", data, {
    jobId: `${data.runId}:${data.stepId}`,
    delay: delayMs,
  });

  return job.id!;
}

export async function enqueueCronSkillStep(
  data: SkillJobData,
  cronExpression: string,
  jobName: string,
): Promise<void> {
  const queue = getSkillQueue(data.workspace);

  await queue.upsertJobScheduler(
    jobName,
    { pattern: cronExpression },
    {
      name: "skill-step",
      data,
    },
  );
}
