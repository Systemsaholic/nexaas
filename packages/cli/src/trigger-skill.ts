/**
 * nexaas trigger-skill — manually trigger a registered skill.
 *
 * Usage:
 *   nexaas trigger-skill <path-to-skill.yaml>
 */

import { readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "crypto";

export async function run(args: string[]) {
  const manifestPath = args[0];
  if (!manifestPath) {
    console.error("Usage: nexaas trigger-skill <path-to-skill.yaml>");
    process.exit(1);
  }

  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  const content = readFileSync(manifestPath, "utf-8");
  const manifest = yamlLoad(content) as { id: string; version: string; execution?: { type: string } };

  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queueName = `nexaas-skills-${workspace}`;
  const queue = new Queue(queueName, { connection });
  const runId = randomUUID();

  await queue.add("skill-step", {
    workspace,
    runId,
    skillId: manifest.id,
    skillVersion: manifest.version,
    stepId: manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec",
    triggerType: "manual",
    manifestPath,
  }, {
    jobId: `manual-${manifest.id.replace(/\//g, "-")}-${Date.now()}`,
  });

  console.log(`\n  ✓ Skill triggered: ${manifest.id}`);
  console.log(`    Run ID: ${runId}`);
  console.log(`    Check Bull Board: http://localhost:9090/queues\n`);

  await connection.quit();
}
