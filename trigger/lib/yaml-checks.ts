/**
 * YAML check config loader for Trigger.dev scheduled checks.
 *
 * Reads operations/memory/checks/*.yaml and converts Nexaas recurrence
 * definitions to cron expressions for Trigger.dev schedules.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { logger } from "@trigger.dev/sdk/v3";

const DEFAULT_CHECKS_DIR = join(
  process.env.WORKSPACE_ROOT || process.env.NEXAAS_ROOT || "/opt/nexaas",
  "operations", "memory", "checks"
);

// ── Types ───────────────────────────────────────────────────────────────────

export interface CheckConfig {
  id: string;
  agent: string;
  description?: string;
  prompt?: string;
  tasks?: string[];
  status: string;
  recurrence: string;
  recurrence_hour?: number;
  recurrence_minute?: number;
  recurrence_day?: string | number;
  recurrence_days?: number[];
  recurrence_months?: number[];
  interval_minutes?: number;
  active_hours?: number[];
  depends_on?: string;
  model?: string;
  notification?: {
    email?: {
      from?: string;
      to?: string;
      subject?: string;
    };
  };
  output?: string;
  type?: string;
  compose_with?: string[];
  template_file?: string;
  /** Per-check MCP server override (array form) */
  mcp_servers?: string[];
  /** Per-check MCP server override (single server shorthand) */
  mcp_server?: string;
  // Extra fields passed through as context
  [key: string]: unknown;
}

// ── Day mapping ─────────────────────────────────────────────────────────────

const DAY_TO_CRON: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

// ── Cron conversion ─────────────────────────────────────────────────────────

export function checkToCron(check: CheckConfig): string | null {
  const minute = check.recurrence_minute ?? 0;
  const hour = check.recurrence_hour ?? 0;

  switch (check.recurrence) {
    case "daily":
      return `${minute} ${hour} * * *`;

    case "weekly": {
      const day = DAY_TO_CRON[String(check.recurrence_day).toLowerCase()];
      if (!day) return null;
      return `${minute} ${hour} * * ${day}`;
    }

    case "monthly": {
      if (check.recurrence_days && check.recurrence_days.length > 0) {
        // Multi-day monthly: e.g., [1, 15]
        return `${minute} ${hour} ${check.recurrence_days.join(",")} * *`;
      }
      const monthDay = check.recurrence_day ?? 1;
      return `${minute} ${hour} ${monthDay} * *`;
    }

    case "interval": {
      const interval = check.interval_minutes ?? 60;
      const hours = check.active_hours;

      // Build minute part
      let minutePart: string;
      if (interval <= 0) return null;
      if (interval < 60 && 60 % interval === 0) {
        minutePart = `*/${interval}`;
      } else if (interval === 60) {
        minutePart = "0";
      } else if (interval >= 60) {
        // For intervals >= 60 min, fire at minute 0 of relevant hours
        minutePart = "0";
      } else {
        // Doesn't divide evenly — approximate
        minutePart = `*/${interval}`;
      }

      // Build hour part
      let hourPart: string;
      if (hours && hours.length > 0) {
        // Check if contiguous range
        const sorted = [...hours].sort((a, b) => a - b);
        const isContiguous =
          sorted.length === sorted[sorted.length - 1] - sorted[0] + 1;
        if (isContiguous) {
          hourPart = `${sorted[0]}-${sorted[sorted.length - 1]}`;
        } else {
          hourPart = sorted.join(",");
        }
      } else {
        hourPart = "*";
      }

      return `${minutePart} ${hourPart} * * *`;
    }

    default:
      return null;
  }
}

// ── Loader ──────────────────────────────────────────────────────────────────

export function loadAllChecks(checksDir?: string): CheckConfig[] {
  const dir = checksDir || DEFAULT_CHECKS_DIR;
  const all: CheckConfig[] = [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch {
    logger.error(`Cannot read checks directory: ${dir}`);
    return [];
  }

  for (const file of files.sort()) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const data = yaml.load(content) as { checks?: CheckConfig[] } | null;
      if (!data?.checks) continue;

      for (const check of data.checks) {
        // Skip null/undefined entries
        if (!check || typeof check !== "object") continue;
        check._source_file = file;
        all.push(check);
      }
    } catch (err) {
      logger.error(`Error loading ${file}: ${err}`);
    }
  }

  return all;
}

export function loadActiveChecks(checksDir?: string): CheckConfig[] {
  return loadAllChecks(checksDir).filter(
    (c) => c.status === "active" && c.id && c.agent && c.recurrence
  );
}

export function loadCheckById(id: string, checksDir?: string): CheckConfig | undefined {
  return loadAllChecks(checksDir).find((c) => c.id === id);
}

// ── Day name mapping (for isDue) ────────────────────────────────────────────

const DAY_NAMES: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Get all active checks that are due right now, given the current ET time.
 * Used by batch dispatchers to find which checks to trigger.
 *
 * The dispatcher frequency determines the window:
 *   - Frequent dispatcher: every 15 min -- checks if minute falls in current 15-min window
 *   - Hourly dispatcher:   at :00 -- catches all daily/weekly/monthly checks whose
 *     target minute falls within the current 15-min window (dispatchers fire at :00, :15, :30, :45)
 *
 * Window logic: A check with recurrence_minute=30 is due when minute is 30-44.
 * This is implemented as: Math.floor(minute / 15) === Math.floor(targetMin / 15)
 * meaning checks are grouped into 15-min buckets: :00-14, :15-29, :30-44, :45-59.
 */
export function getDueChecks(
  now: Date,
  recurrenceFilter?: string,
  checksDir?: string
): CheckConfig[] {
  const checks = loadActiveChecks(checksDir);
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayOfWeek = now.getDay(); // 0=Sun
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const minuteBucket = Math.floor(minute / 15); // 0, 1, 2, or 3

  return checks.filter((check) => {
    if (recurrenceFilter && check.recurrence !== recurrenceFilter) return false;

    switch (check.recurrence) {
      case "daily": {
        const targetHour = check.recurrence_hour ?? 0;
        const targetMin = check.recurrence_minute ?? 0;
        if (hour !== targetHour) return false;
        // Same 15-min bucket: :00-14, :15-29, :30-44, :45-59
        return Math.floor(targetMin / 15) === minuteBucket;
      }

      case "weekly": {
        const targetDay = DAY_NAMES[String(check.recurrence_day).toLowerCase()];
        const targetHour = check.recurrence_hour ?? 0;
        const targetMin = check.recurrence_minute ?? 0;
        if (targetDay === undefined || dayOfWeek !== targetDay) return false;
        if (hour !== targetHour) return false;
        return Math.floor(targetMin / 15) === minuteBucket;
      }

      case "monthly": {
        const targetHour = check.recurrence_hour ?? 0;
        const targetMin = check.recurrence_minute ?? 0;
        if (check.recurrence_months && !check.recurrence_months.includes(month)) return false;
        if (check.recurrence_days) {
          if (!check.recurrence_days.includes(dayOfMonth)) return false;
        } else {
          const targetDay = (check.recurrence_day as number) ?? 1;
          if (dayOfMonth !== targetDay) return false;
        }
        if (hour !== targetHour) return false;
        return Math.floor(targetMin / 15) === minuteBucket;
      }

      case "interval": {
        const activeHours = check.active_hours;
        // Empty active_hours with no length = 24/7, otherwise check the list
        if (activeHours && activeHours.length > 0 && !activeHours.includes(hour)) return false;
        // Match interval to dispatcher frequency:
        // - Every 15 min: fires every tick (minuteBucket always matches)
        // - Every 30 min: fires at :00 and :30 (buckets 0 and 2)
        // - Every 60 min: fires at :00 only (bucket 0)
        // - Every 120 min: fires at :00 of every 2nd active hour
        const interval = check.interval_minutes ?? 60;
        if (interval <= 15) return true; // every tick
        if (interval <= 30) return minuteBucket === 0 || minuteBucket === 2;
        if (interval <= 60) return minuteBucket === 0;
        // >= 120 min: fire at :00 of even hours only
        return minuteBucket === 0 && hour % 2 === 0;
      }

      default:
        return false;
    }
  });
}

/**
 * Build the prompt to send to Claude for a given check.
 *
 * Priority: explicit `prompt` field > `tasks` list > `description`
 */
export function buildCheckPrompt(check: CheckConfig): string {
  if (!check) return "ERROR: Null or undefined check config";
  if (check.prompt) return check.prompt;

  const parts: string[] = [];

  if (check.description) {
    parts.push(check.description.trim());
  }

  if (check.tasks && check.tasks.length > 0) {
    parts.push("\nSteps:");
    for (const task of check.tasks) {
      parts.push(`- ${task}`);
    }
  }

  // Pass through extra context fields
  if (check.notification?.email) {
    parts.push(
      `\nAfter completing the task, email results to ${check.notification.email.to} from ${check.notification.email.from}.`
    );
    if (check.notification.email.subject) {
      parts.push(`Subject: ${check.notification.email.subject}`);
    }
  }

  if (check.output) {
    parts.push(`\nSave the report to Nextcloud at path: ${check.output}`);
  }

  return parts.join("\n");
}
