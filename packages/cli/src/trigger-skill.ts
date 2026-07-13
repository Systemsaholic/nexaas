/**
 * nexaas trigger-skill — manually trigger a registered skill.
 *
 * Usage:
 *   nexaas trigger-skill <path-to-skill.yaml>
 */

import { loadManifest } from "@nexaas/manifest";
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

  // Shared loader (#256) — a contract.yaml skill triggers with its derived
  // `category/skill` id instead of `undefined`.
  const manifest = loadManifest(manifestPath);
  if (!manifest.id || !manifest.version) {
    console.error(`Manifest at ${manifestPath} is missing required 'id' or 'version'`);
    process.exit(1);
  }

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
