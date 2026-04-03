/**
 * Skill sync task — Phase 2.
 *
 * Will propagate skill updates from nexaas/skills/ to subscribed workspaces.
 * For now, this is a placeholder.
 */

import { task, logger } from "@trigger.dev/sdk/v3";

export const syncSkills = task({
  id: "sync-skills",
  queue: { name: "skill-sync", concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: { skillId?: string; workspaceId?: string }) => {
    logger.info("sync-skills is a Phase 2 stub", payload);
    return { status: "not-implemented" };
  },
});
