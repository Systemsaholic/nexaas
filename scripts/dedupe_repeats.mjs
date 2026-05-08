#!/usr/bin/env node
/**
 * Safely dedupe BullMQ repeatable jobs in a Nexaas workspace queue.
 *
 * Why this script exists (#105): every `skill-step` job in a Nexaas
 * workspace shares the same Job.name. The unique identity of a
 * scheduled cron is the repeatable `key` (e.g. `cron-<skill-id>`).
 * An unsafe earlier draft grouped by `r.name`, which would have
 * collapsed the entire schedule of ~120 distinct skills into one
 * winner. This script groups by `r.key` instead, keeping the most
 * recent `next` per cron and dropping older duplicates of the same key.
 *
 * Usage:
 *   node scripts/dedupe_repeats.mjs                    # dry-run
 *   node scripts/dedupe_repeats.mjs --apply            # actually delete
 *   node scripts/dedupe_repeats.mjs --queue=<name>     # override queue name
 *
 * Defaults:
 *   queue   = `nexaas-skills-${NEXAAS_WORKSPACE}`
 *   redis   = REDIS_URL (or redis://localhost:6379)
 *   workspace = NEXAAS_WORKSPACE
 *
 * Safety:
 *   - dry-run by default (must pass --apply to mutate Redis)
 *   - groups by `r.key` (not `r.name`) — matches BullMQ's actual
 *     unique identifier for a repeatable
 *   - never drops a key that has only one entry
 *   - keeps the entry with the latest `next` timestamp
 *
 * If you see "Groups with duplicates: 0", your schedule is clean —
 * any apparent multi-fire is from somewhere else (claim-stuck,
 * doubled scheduler, etc).
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

function parseArgs(argv) {
  const out = { apply: false, queue: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--queue=")) out.queue = a.slice("--queue=".length);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/dedupe_repeats.mjs [--apply] [--queue=<name>]
Defaults to dry-run. Set --apply to actually delete duplicate repeatables.`);
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const workspace = process.env.NEXAAS_WORKSPACE;
const queueName = args.queue ?? (workspace ? `nexaas-skills-${workspace}` : null);
if (!queueName) {
  console.error("queue name required: set NEXAAS_WORKSPACE or pass --queue=<name>");
  process.exit(1);
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const conn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
const queue = new Queue(queueName, { connection: conn });

try {
  const repeats = await queue.getRepeatableJobs();
  console.log(`Queue: ${queueName}`);
  console.log(`Found ${repeats.length} repeatable job entries\n`);

  const groups = new Map();
  for (const r of repeats) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  let totalToRemove = 0;
  const dropList = [];
  for (const [key, entries] of groups) {
    if (entries.length <= 1) continue;
    // Keep the one with the latest `next`; drop the rest.
    entries.sort((a, b) => Number(b.next) - Number(a.next));
    const [keep, ...drop] = entries;
    console.log(`  ${key} (${entries.length} entries)`);
    console.log(`    KEEP: next=${new Date(Number(keep.next)).toISOString()}`);
    for (const d of drop) {
      console.log(`    DROP: next=${new Date(Number(d.next)).toISOString()}  pattern=${d.pattern ?? "(no pattern)"}`);
      dropList.push(d);
    }
    totalToRemove += drop.length;
  }

  const dupeGroups = [...groups.values()].filter((e) => e.length > 1).length;
  console.log(`\nGroups with duplicates: ${dupeGroups}`);
  console.log(`Total entries to remove: ${totalToRemove}`);

  if (totalToRemove === 0) {
    console.log("\nNothing to do.");
  } else if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to delete.");
  } else {
    console.log("\nApplying...");
    for (const d of dropList) {
      await queue.removeRepeatableByKey(d.key);
      console.log(`  removed ${d.key} (next=${new Date(Number(d.next)).toISOString()})`);
    }
    console.log(`\nDone. Removed ${dropList.length} entries.`);
  }
} finally {
  await queue.close();
  await conn.quit();
}
