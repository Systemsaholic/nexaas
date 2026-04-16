/**
 * The pillar pipeline — the fixed execution path for every skill step.
 *
 * CAG → RAG → Model → TAG → Engine
 *
 * Skill authors never call this directly. The runtime invokes it
 * when a BullMQ job fires for a skill step.
 */

import { palace, type PalaceSession } from "@nexaas/palace";
import { assemble } from "./cag/assemble.js";
import { retrieve } from "./rag/retrieve.js";
import { ModelGateway } from "./models/gateway.js";
import { route } from "./tag/route.js";
import { apply } from "./engine/apply.js";
import { runTracker } from "./run-tracker.js";

export interface SkillStepParams {
  workspace: string;
  runId: string;
  skillId: string;
  skillVersion?: string;
  stepId: string;
  resumedWith?: Record<string, unknown>;
}

export async function runSkillStep(params: SkillStepParams): Promise<void> {
  const { workspace, runId, skillId, stepId, resumedWith } = params;

  await runTracker.markStepStarted(runId, stepId);

  const session = palace.enter({
    workspace,
    runId,
    skillId,
    stepId,
  });

  try {
    const context = await assemble({
      session,
      stepId,
      resumedWith,
    });

    const retrieval = await retrieve({
      session,
      context,
    });

    const modelResult = await ModelGateway.execute({
      tier: context.modelTier,
      messages: context.messages,
      system: context.systemPrompt,
      tools: context.tools,
      retrieval,
      workspaceId: workspace,
      runId,
      stepId,
    });

    const routing = await route({
      output: modelResult,
      skillId,
      workspace,
    });

    for (const action of routing.actions) {
      await apply(action, {
        session,
        runId,
        stepId,
      });
    }

    await runTracker.markStepCompleted(runId, stepId);
  } catch (err) {
    await runTracker.markStepFailed(runId, stepId, err);
    throw err;
  }
}
