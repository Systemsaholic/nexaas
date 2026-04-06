/**
 * HEARTBEAT Provisioner — creates Trigger.dev schedules for active departments.
 *
 * Architecture Guide v4 §12
 *
 * Reads department templates from templates/heartbeat/.
 * Creates Trigger.dev schedules with IANA timezone + externalId.
 * Stores schedule records in heartbeat_schedules table.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { query } from "../db.js";
import { logger } from "@trigger.dev/sdk/v3";

const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

interface HeartbeatTemplate {
  department: string;
  schedules: Array<{
    key: string;
    cron: string;
    description: string;
    silence_if: string;
  }>;
}

/**
 * Load all HEARTBEAT templates from templates/heartbeat/.
 */
export function loadHeartbeatTemplates(): HeartbeatTemplate[] {
  const dir = join(NEXAAS_ROOT, "templates", "heartbeat");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  return files.map((f) => {
    const raw = readFileSync(join(dir, f), "utf-8");
    return yaml.load(raw) as HeartbeatTemplate;
  });
}

/**
 * Provision HEARTBEAT schedules for a workspace.
 *
 * Creates schedule records in the DB. The actual Trigger.dev schedules
 * are created by a separate task that reads these records.
 */
export async function provisionClientHeartbeats(
  workspaceId: string,
  departments: string[],
  timezone: string,
): Promise<{ created: number; skipped: number }> {
  const templates = loadHeartbeatTemplates();
  let created = 0;
  let skipped = 0;

  for (const template of templates) {
    if (!departments.includes(template.department)) {
      continue;
    }

    for (const schedule of template.schedules) {
      const externalId = `${workspaceId}:${template.department}:${schedule.key}`;

      try {
        const result = await query(
          `INSERT INTO heartbeat_schedules
           (workspace_id, department, schedule_key, cron, timezone,
            trigger_task_id, external_id, silence_condition, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
           ON CONFLICT (workspace_id, department, schedule_key) DO NOTHING
           RETURNING id`,
          [
            workspaceId,
            template.department,
            schedule.key,
            schedule.cron,
            timezone,
            `heartbeat-${template.department}`,
            externalId,
            schedule.silence_if === "never" ? null : schedule.silence_if,
          ]
        );

        if (result.rows.length > 0) {
          created++;
          logger.info(`HEARTBEAT provisioned: ${externalId}`);
        } else {
          skipped++;
        }
      } catch (e) {
        logger.warn(`Failed to provision ${externalId}: ${(e as Error).message}`);
        skipped++;
      }
    }
  }

  return { created, skipped };
}

/**
 * Get all active HEARTBEAT schedules for a workspace.
 */
export async function getWorkspaceHeartbeats(workspaceId: string) {
  const result = await query(
    `SELECT * FROM heartbeat_schedules WHERE workspace_id = $1 AND active = true ORDER BY department, schedule_key`,
    [workspaceId]
  );
  return result.rows;
}
