/**
 * nexaas register-skill — register a skill manifest with the BullMQ scheduler.
 *
 * Usage:
 *   nexaas register-skill /path/to/skill.yaml
 *
 * Reads the manifest, registers cron triggers with BullMQ, and confirms.
 */

import { readFileSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

interface SkillManifest {
  id: string;
  version: string;
  description?: string;
  triggers?: Array<{
    type: string;
    schedule?: string;
  }>;
  execution?: {
    type: string;
    command?: string;
    timeout?: number;
    working_directory?: string;
  };
}

export async function run(args: string[]) {
  const manifestPath = args[0];
  if (!manifestPath) {
    console.error("Usage: nexaas register-skill <path-to-skill.yaml>");
    process.exit(1);
  }

  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  const content = readFileSync(manifestPath, "utf-8");
  const manifest = yamlLoad(content) as SkillManifest;

  console.log(`\n  Registering skill: ${manifest.id} v${manifest.version}`);
  if (manifest.description) console.log(`  Description: ${manifest.description}`);

  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queueName = `nexaas-skills-${workspace}`;
  const queue = new Queue(queueName, { connection });

  let registered = 0;

  if (manifest.triggers) {
    for (const trigger of manifest.triggers) {
      if (trigger.type === "cron" && trigger.schedule) {
        const jobName = `cron-${manifest.id.replace(/\//g, "-")}`;

        await queue.upsertJobScheduler(
          jobName,
          { pattern: trigger.schedule },
          {
            name: "skill-step",
            data: {
              workspace,
              skillId: manifest.id,
              skillVersion: manifest.version,
              stepId: "shell-exec",
              triggerType: "cron",
              manifestPath,
            },
          },
        );

        console.log(`  ✓ Cron registered: ${trigger.schedule} → ${jobName}`);
        registered++;
      }
    }
  }

  if (registered === 0) {
    console.log("  ⚠ No cron triggers found in this manifest");
  }

  await connection.quit();
  console.log(`\n  Skill registered. Next fire will appear in Bull Board at /queues\n`);
}
