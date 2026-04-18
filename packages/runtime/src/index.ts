/**
 * @nexaas/runtime — Pillar pipeline runtime for the Nexaas framework.
 *
 * Every skill step execution flows through: CAG → RAG → Model → TAG → Engine
 *
 * This package provides:
 * - runSkillStep() — the main pipeline entry point
 * - ModelGateway — provider-agnostic model execution with tier-based selection
 * - TAG routing — Option C layered policy enforcement
 * - CAG context assembly — palace-walking context builder
 * - RAG retrieval — pgvector-backed semantic search
 * - Sub-agent invocation — L1 focused Claude calls
 * - runTracker — library-enforced skill_runs state transitions
 */

export { runSkillStep } from "./pipeline.js";
export { ModelGateway } from "./models/gateway.js";
export { route as tagRoute } from "./tag/route.js";
export { assemble as cagAssemble } from "./cag/assemble.js";
export { retrieve as ragRetrieve } from "./rag/retrieve.js";
export { subagent } from "./subagent.js";
export { runTracker } from "./run-tracker.js";
export {
  enqueueSkillStep,
  enqueueDelayedSkillStep,
  enqueueCronSkillStep,
  startWorker,
  startOutboxRelay,
  type SkillJobData,
} from "./bullmq/index.js";
export { runCompaction } from "./tasks/closet-compaction.js";
export { reapExpiredWaitpoints, sendPendingReminders } from "./tasks/waitpoint-reaper.js";
