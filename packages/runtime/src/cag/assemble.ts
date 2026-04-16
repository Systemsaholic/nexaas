/**
 * CAG — Context-Augmented Generation.
 *
 * Assembles the full context a skill step needs by walking the palace:
 * - Behavioral contract (tone, approval posture, escalation rules)
 * - Live workspace state (integration snapshots, active resources)
 * - Workflow execution state (prior drawers in this run, decisions made)
 * - Retrieval room contents (declared in skill manifest)
 */

import type { PalaceSession, Drawer } from "@nexaas/palace";
import { sql } from "@nexaas/palace";
import type { ModelTier, Message, Tool } from "../models/gateway.js";

export interface SkillManifestFull {
  id: string;
  version: string;
  description?: string;
  steps?: Array<{
    id: string;
    model_tier?: ModelTier;
    prompt?: string;
  }>;
  requires?: {
    capabilities?: string[];
  };
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
    retrieval_rooms?: Array<{ wing: string; hall: string; room: string }>;
  };
  outputs?: Array<{
    id: string;
    routing_default: string;
    overridable?: boolean;
    overridable_to?: string[];
  }>;
}

export interface AssembleParams {
  session: PalaceSession;
  stepId: string;
  resumedWith?: Record<string, unknown>;
  manifest?: SkillManifestFull;
  contractTone?: string;
  contractRules?: string;
  promptTemplate?: string;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  modelTier: ModelTier;
  retrievalRooms: Array<{ wing: string; hall: string; room: string }>;
}

export async function assemble(params: AssembleParams): Promise<AssembledContext> {
  const { session, stepId, resumedWith, manifest, contractTone, contractRules, promptTemplate } = params;

  // Resolve model tier for this step
  const step = manifest?.steps?.find((s) => s.id === stepId);
  const modelTier: ModelTier = (step?.model_tier as ModelTier) ?? "good";

  // Build the system prompt
  const promptParts: string[] = [];

  // 1. Skill prompt template
  if (promptTemplate) {
    promptParts.push(promptTemplate);
  } else if (step?.prompt) {
    promptParts.push(step.prompt);
  }

  // 2. Behavioral contract — tone and rules
  if (contractTone) {
    promptParts.push(`\n## Communication Style\n${contractTone}`);
  }
  if (contractRules) {
    promptParts.push(`\n## Rules and Constraints\n${contractRules}`);
  }

  const systemPrompt = promptParts.join("\n\n");

  // Gather context from palace rooms
  const messages: Message[] = [];
  const retrievalRooms = manifest?.rooms?.retrieval_rooms ?? [];

  // Walk each retrieval room and collect drawer content
  for (const room of retrievalRooms) {
    const drawers = await session.walkRoom(room, { limit: 20 });
    if (drawers.length > 0) {
      const roomContent = drawers
        .map((d: Drawer) => d.content)
        .join("\n---\n");
      messages.push({
        role: "user",
        content: `[Context from ${room.wing}/${room.hall}/${room.room}]:\n${roomContent}`,
      });
    }
  }

  // If this is a resumed run, include the resume context
  if (resumedWith) {
    messages.push({
      role: "user",
      content: `[Resumed with decision]: ${JSON.stringify(resumedWith)}`,
    });
  }

  // Load prior drawers from this run for continuity
  if (session.ctx.runId) {
    const priorDrawers = await sql<Drawer>(
      `SELECT content, step_id, created_at FROM nexaas_memory.events
       WHERE run_id = $1 AND workspace = $2
       ORDER BY created_at ASC
       LIMIT 50`,
      [session.ctx.runId, session.ctx.workspace],
    );

    if (priorDrawers.length > 0) {
      const history = priorDrawers
        .map((d) => `[Step ${d.step_id}]: ${d.content}`)
        .join("\n");
      messages.push({
        role: "user",
        content: `[Prior steps in this run]:\n${history}`,
      });
    }
  }

  // Add the main task instruction
  messages.push({
    role: "user",
    content: manifest?.description
      ? `Task: ${manifest.description}`
      : "Execute the current step according to the system prompt and context provided.",
  });

  // Resolve tools from capability bindings
  // For now, tools are passed in from the pipeline; capability resolution happens at the pipeline level
  const tools: Tool[] = [];

  // Record staleness telemetry for each walked room
  for (const room of retrievalRooms) {
    const watermark = await sql<{ last_compacted_at: Date }>(
      `SELECT last_compacted_at FROM nexaas_memory.room_compaction_state
       WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4`,
      [session.ctx.workspace, room.wing, room.hall, room.room],
    );

    const compactionTime = watermark[0]?.last_compacted_at ?? new Date(0);
    const liveTail = await sql<{ count: string }>(
      `SELECT count(*) FROM nexaas_memory.events
       WHERE workspace = $1 AND wing = $2 AND hall = $3 AND room = $4
         AND created_at > $5`,
      [session.ctx.workspace, room.wing, room.hall, room.room, compactionTime],
    );

    const liveTailCount = parseInt(liveTail[0]?.count ?? "0", 10);
    const oldestTailAge = liveTailCount > 0
      ? Date.now() - compactionTime.getTime()
      : 0;

    await sql(
      `INSERT INTO nexaas_memory.staleness_readings
        (workspace, wing, hall, room, cag_run_id, closets_read, live_tail_drawers, live_tail_age_ms, compaction_watermark)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
      [
        session.ctx.workspace, room.wing, room.hall, room.room,
        session.ctx.runId,
        liveTailCount, oldestTailAge, compactionTime,
      ],
    );
  }

  return {
    systemPrompt,
    messages,
    tools,
    modelTier,
    retrievalRooms,
  };
}
