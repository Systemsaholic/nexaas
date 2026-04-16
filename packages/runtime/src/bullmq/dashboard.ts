/**
 * Bull Board — embedded queue dashboard for Nexaas runtime visibility.
 *
 * Framework-level feature: every Nexaas install gets a queue dashboard
 * at /queues on the health port. No Nexmatic required.
 *
 * Provides:
 * - Active, completed, failed, delayed, waiting job lists
 * - Job details, payloads, error messages
 * - Manual retry, remove, promote operations
 * - Real-time queue metrics
 */

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { ExpressAdapter } from "@bull-board/express";
import { getSkillQueue } from "./queues.js";

let _serverAdapter: ExpressAdapter | null = null;

export function createDashboard(workspaceId: string): ExpressAdapter {
  if (_serverAdapter) return _serverAdapter;

  _serverAdapter = new ExpressAdapter();
  _serverAdapter.setBasePath("/queues");

  const queue = getSkillQueue(workspaceId);

  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter: _serverAdapter,
  });

  return _serverAdapter;
}
