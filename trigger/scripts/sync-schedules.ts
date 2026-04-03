/**
 * Sync YAML checks -> Trigger.dev schedules.
 *
 * Reads all operations/memory/checks/*.yaml files and creates/updates
 * imperative schedules via the Trigger.dev SDK.
 *
 * Usage:
 *   npx tsx scripts/sync-schedules.ts                    # Sync all domains
 *   npx tsx scripts/sync-schedules.ts system-checks.yaml # Sync one domain
 *   npx tsx scripts/sync-schedules.ts --dry-run           # Preview only
 *
 * Each active check with a valid cron expression gets a schedule pointing
 * to the "scheduled-check" task with externalId = check.id.
 */

import { schedules } from "@trigger.dev/sdk/v3";
import {
  loadAllChecks,
  checkToCron,
  type CheckConfig,
} from "../lib/yaml-checks.js";

const TASK_ID = "scheduled-check";
const TIMEZONE = process.env.TRIGGER_TIMEZONE || "America/Toronto";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fileFilter = args.find((a) => a.endsWith(".yaml"));

  console.log(
    `\nSyncing YAML checks -> Trigger.dev schedules${dryRun ? " (DRY RUN)" : ""}\n`
  );

  // Load all checks
  let checks = loadAllChecks();

  // Filter by file if specified
  if (fileFilter) {
    checks = checks.filter((c) => c._source_file === fileFilter);
    console.log(`Filtering to ${fileFilter}: ${checks.length} checks\n`);
  }

  // Get existing schedules for comparison
  let existingSchedules: Map<string, string> = new Map();
  try {
    const existing = await schedules.list({ page: 1, perPage: 200 });
    for (const s of existing.data) {
      if (s.externalId) {
        existingSchedules.set(s.externalId, s.id);
      }
    }
    console.log(`Found ${existingSchedules.size} existing schedules\n`);
  } catch (err) {
    console.log(`Could not fetch existing schedules: ${err}\n`);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const check of checks) {
    const id = check.id;

    // Skip non-active, already migrated, or disabled checks
    if (check.status !== "active") {
      if (check.status === "migrated") {
        console.log(`  [skip] ${id} -- already migrated to TD`);
      } else {
        console.log(`  [skip] ${id} -- status: ${check.status}`);
      }
      skipped++;
      continue;
    }

    // Convert recurrence to cron
    const cron = checkToCron(check);
    if (!cron) {
      console.log(
        `  [warn] ${id} -- cannot convert recurrence "${check.recurrence}" to cron`
      );
      errors++;
      continue;
    }

    const existingId = existingSchedules.get(id);

    if (dryRun) {
      console.log(
        `  ${existingId ? "[update]" : "[create]"} ${id} -> "${cron}" (${TIMEZONE}) [${check.agent}]`
      );
      existingId ? updated++ : created++;
      continue;
    }

    try {
      if (existingId) {
        // Update existing schedule
        await schedules.update(existingId, {
          task: TASK_ID,
          cron,
          externalId: id,
          timezone: TIMEZONE,
        });
        console.log(`  [update] ${id} -> "${cron}" (updated)`);
        updated++;
      } else {
        // Create new schedule
        await schedules.create({
          task: TASK_ID,
          cron,
          externalId: id,
          timezone: TIMEZONE,
          deduplicationKey: id,
        });
        console.log(`  [create] ${id} -> "${cron}" (created)`);
        created++;
      }
    } catch (err) {
      console.error(`  [error] ${id} -- ${err}`);
      errors++;
    }
  }

  console.log(`
-----------------------------
  Created:  ${created}
  Updated:  ${updated}
  Skipped:  ${skipped}
  Errors:   ${errors}
  Total:    ${checks.length}
-----------------------------
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
