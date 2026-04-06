/**
 * Cron schedule definitions.
 *
 * Re-exports all scheduled tasks so Trigger.dev discovers them.
 * Workspace-specific schedules are defined in their respective task files.
 */

// Skill runner schedules (batch dispatch)
export { dispatchFrequent, scheduledCheck } from "../tasks/run-skill.js";

// Core orchestration schedules
export { scanWorkspacesSchedule } from "../tasks/scan-workspaces.js";
export { checkApprovalsSchedule } from "../tasks/check-approvals.js";

// Instance health & maintenance schedules
export { collectHealthSchedule } from "../tasks/collect-health.js";
export { maintainInstancesSchedule } from "../tasks/maintain-instances.js";

// Architectural integrity check (daily 6am)
export { integrityCheckSchedule } from "../tasks/integrity-check.js";

// Cron task schedules (add workspace-specific exports here)
// export { myTaskSchedule } from "../tasks/cron-tasks.js";
