/**
 * The pillar pipeline — the fixed execution path for every skill step.
 *
 * CAG → RAG → Model → TAG → Engine
 *
 * Skill authors never call this directly. The runtime invokes it
 * when a BullMQ job fires for a skill step.
 */

import { palace } from "@nexaas/palace";
import { assemble, type SkillManifestFull } from "./cag/assemble.js";
import { retrieve } from "./rag/retrieve.js";
import { ModelGateway } from "./models/gateway.js";
import { route, type SkillManifest, type BehavioralContract } from "./tag/route.js";
import { apply } from "./engine/apply.js";
import { runTracker } from "./run-tracker.js";
import { loadWorkspaceManifest } from "./schemas/load-manifest.js";

export interface SkillStepParams {
  workspace: string;
  runId: string;
  skillId: string;
  skillVersion?: string;
  stepId: string;
  resumedWith?: Record<string, unknown>;
  manifest?: SkillManifestFull;
  tagManifest?: SkillManifest;
  contract?: BehavioralContract;
  promptTemplate?: string;
  contractTone?: string;
  contractRules?: string;
}

export async function runSkillStep(params: SkillStepParams): Promise<void> {
  const {
    workspace, runId, skillId, stepId, resumedWith,
    manifest, tagManifest, contract, promptTemplate,
    contractTone, contractRules,
  } = params;

  await runTracker.markStepStarted(runId, stepId);

  const session = palace.enter({
    workspace,
    runId,
    skillId,
    stepId,
  });

  try {
    // 1. CAG — assemble context by walking the palace
    const context = await assemble({
      session,
      stepId,
      resumedWith,
      manifest,
      contractTone,
      contractRules,
      promptTemplate,
    });

    // 2. RAG — retrieve semantically similar drawers
    const retrieval = await retrieve({
      session,
      context,
    });

    // 3. Model — invoke Claude (or fallback) via the gateway
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

    // Update token usage on the run
    await runTracker.updateTokenUsage(runId, modelResult.tokenUsage);

    // 4. TAG — enforce policy on each proposed action
    const routing = await route({
      output: modelResult,
      skillId,
      workspace,
      manifest: tagManifest,
      contract,
    });

    // 5. Engine — apply each routing decision. Loads workspace manifest
    // once per step so engine can resolve channel_role templates against
    // channel_bindings (#41). Missing manifest is non-fatal; engine falls
    // back to the raw role string.
    const { manifest: workspaceManifest } = await loadWorkspaceManifest(workspace);
    for (const action of routing.actions) {
      await apply(action, {
        session,
        runId,
        stepId,
        workspaceManifest,
      });
    }

    // If no action resulted in waiting/escalation, mark step completed
    const hasWaiting = routing.actions.some(
      (a) => a.routing === "approval_required" || a.routing === "escalate",
    );

    if (!hasWaiting) {
      await runTracker.markStepCompleted(runId, stepId);
    }
  } catch (err) {
    await runTracker.markStepFailed(runId, stepId, err);
    throw err;
  }
}
