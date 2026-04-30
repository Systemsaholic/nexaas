/**
 * Inbound-message trigger dispatcher (issue #39 Stage 1).
 *
 * Watches `inbox.messaging.<role>` drawers written by channel adapters.
 * For each new drawer, looks up skills whose manifest declares:
 *
 *   triggers:
 *     - type: inbound-message
 *       channel_role: <role>
 *
 * and enqueues one BullMQ job per subscribed skill (parallel dispatch,
 * not sequential — per architecture.md §9 event-driven composition).
 *
 * Per-drawer × skill dispatch is logged in `inbound_dispatches` so a
 * re-poll never re-fires the same skill for the same drawer. Multiple
 * skills subscribing to the same role each get their own row + BullMQ job.
 *
 * Scope of Stage 1:
 *   - Generic inbound-message trigger firing. Works for any skill that
 *     declares the trigger — framework-agnostic to what the skill does
 *     with the drawer.
 *   - Approval-callback resolution (button click → resolveWaitpoint) is
 *     NOT handled here. That's a separate concern — see the design note
 *     below for how it composes.
 *   - The room-pattern-dispatcher generalization shared with #40
 *     outbound is deferred; for now both dispatchers are purpose-built.
 *
 * Design note on approval callbacks:
 *   When an approver taps an inline button, the channel adapter writes
 *   an inbox drawer with `action_button_click: { button_id, message_id }`.
 *   The button_id is expected to encode the waitpoint signal (e.g.,
 *   "approval:<run_id>:...:approve"). A thin approval-resolver task
 *   watches drawers whose `action_button_click.button_id` starts with
 *   "approval:" and calls `palace.resolveWaitpoint(signal, ...)`. That
 *   task is orthogonal to this dispatcher and will land in Stage 1b.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { load as yamlLoad } from "js-yaml";
import { sql, appendWal } from "@nexaas/palace";
import { enqueueSkillStep, type SkillJobData } from "../bullmq/queues.js";
import { matchDrawerAgainstWaitpoints } from "./inbound-match-waitpoint.js";
import { reportMissingRelation } from "./_consistency-warning.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const POLL_BATCH_SIZE = 50;
const INDEX_TTL_MS = 30_000;

interface InboundManifest {
  id: string;
  version?: string;
  execution?: { type?: string };
  triggers?: Array<{
    type: string;
    channel_role?: string;
    schedule?: string;
  }>;
}

/** role → list of (skillId, manifestPath, execType) that subscribe to it. */
type InboundIndex = Map<string, Array<{ skillId: string; manifestPath: string; execType: string }>>;

interface CachedIndex {
  index: InboundIndex;
  builtAt: number;
}

let _cached: CachedIndex | null = null;
let _polling = false;
let _interval: NodeJS.Timeout | null = null;

function findSkillManifests(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const out: string[] = [];
  for (const category of readdirSync(skillsRoot)) {
    const catPath = join(skillsRoot, category);
    try { if (!statSync(catPath).isDirectory()) continue; } catch { continue; }
    for (const name of readdirSync(catPath)) {
      const skillPath = join(catPath, name);
      try { if (!statSync(skillPath).isDirectory()) continue; } catch { continue; }
      const manifestPath = join(skillPath, "skill.yaml");
      if (existsSync(manifestPath)) out.push(manifestPath);
    }
  }
  return out;
}

function buildInboundIndex(skillsRoot: string): InboundIndex {
  const index: InboundIndex = new Map();
  for (const manifestPath of findSkillManifests(skillsRoot)) {
    let manifest: InboundManifest;
    try {
      manifest = yamlLoad(readFileSync(manifestPath, "utf-8")) as InboundManifest;
    } catch {
      continue; // malformed manifest — skip silently, scheduler self-heal logs these
    }
    const triggers = (manifest.triggers ?? []).filter(
      (t) => t.type === "inbound-message" && typeof t.channel_role === "string" && t.channel_role.length > 0,
    );
    if (triggers.length === 0) continue;
    const execType = manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec";
    for (const trigger of triggers) {
      const role = trigger.channel_role!;
      const entries = index.get(role) ?? [];
      entries.push({ skillId: manifest.id, manifestPath, execType });
      index.set(role, entries);
    }
  }
  return index;
}

function getInboundIndex(): InboundIndex {
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  if (!workspaceRoot) return new Map();
  const now = Date.now();
  if (_cached && now - _cached.builtAt < INDEX_TTL_MS) return _cached.index;
  const index = buildInboundIndex(join(workspaceRoot, "nexaas-skills"));
  _cached = { index, builtAt: now };
  return index;
}

export function invalidateInboundIndex(): void {
  _cached = null;
}

interface PendingInbound {
  id: string;
  wing: string;
  hall: string;
  room: string;
  content: string;
  created_at: string;
}

async function selectPending(workspace: string): Promise<PendingInbound[]> {
  return await sql<PendingInbound>(
    `SELECT e.id, e.wing, e.hall, e.room, e.content, e.created_at
       FROM nexaas_memory.events e
      WHERE e.workspace = $1
        AND e.wing = 'inbox'
        AND e.hall = 'messaging'
        AND e.dormant_signal IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM nexaas_memory.inbound_dispatches d
           WHERE d.workspace = e.workspace AND d.drawer_id = e.id
        )
      ORDER BY e.created_at ASC
      LIMIT $2`,
    [workspace, POLL_BATCH_SIZE],
  );
}

async function recordDispatch(
  workspace: string,
  drawerId: string,
  skillId: string,
  runId: string,
  status: "dispatched" | "failed",
  error?: string,
): Promise<void> {
  await sql(
    `INSERT INTO nexaas_memory.inbound_dispatches
        (workspace, drawer_id, skill_id, run_id, status, error)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace, drawer_id, skill_id) DO NOTHING`,
    [workspace, drawerId, skillId, runId, status, error ?? null],
  );
}

export async function dispatchPendingInbound(workspace: string): Promise<{
  drawers: number;
  dispatches: number;
  failed: number;
  noSubscriber: number;
}> {
  const pending = await selectPending(workspace);
  const index = getInboundIndex();

  let drawers = 0, dispatches = 0, failed = 0, noSubscriber = 0;

  for (const drawer of pending) {
    drawers++;
    // Room = channel_role. Adapters MUST use this convention so the
    // dispatcher can route without scanning drawer content.
    const channelRole = drawer.room;

    // #49 — check inbound-match waitpoints first (first-match-wins).
    // Match does NOT short-circuit skill fanout; drawer is observable
    // by both paths. Errors here don't block skill firing either.
    try {
      await matchDrawerAgainstWaitpoints(workspace, {
        id: drawer.id,
        room: drawer.room,
        content: drawer.content,
        created_at: drawer.created_at,
      });
    } catch (err) {
      console.warn(
        `[nexaas] inbound-match check failed for drawer ${drawer.id}: ${(err as Error).message}`,
      );
    }

    const subscribers = index.get(channelRole);

    if (!subscribers || subscribers.length === 0) {
      // No skill subscribed — mark dispatched with status to prevent
      // re-scan. A "ghost dispatch" row with skill_id "(none)" acts as
      // the poll-suppression marker. If a skill is later added that
      // subscribes to this role, operators can clear these rows to
      // replay historical drawers.
      await recordDispatch(workspace, drawer.id, "(none)", randomUUID(), "dispatched", "no subscriber");
      await appendWal({
        workspace,
        op: "inbound_no_subscriber",
        actor: "inbound-dispatcher",
        payload: {
          drawer_id: drawer.id,
          channel_role: channelRole,
        },
      });
      noSubscriber++;
      continue;
    }

    for (const sub of subscribers) {
      const runId = randomUUID();
      const jobData: SkillJobData & { manifestPath?: string } = {
        workspace,
        runId,
        skillId: sub.skillId,
        stepId: sub.execType,
        triggerType: "inbound-message",
        triggerPayload: {
          drawer_id: drawer.id,
          channel_role: channelRole,
          wing: drawer.wing,
          hall: drawer.hall,
          room: drawer.room,
        },
        manifestPath: sub.manifestPath,
      };

      try {
        await enqueueSkillStep(jobData);
        await recordDispatch(workspace, drawer.id, sub.skillId, runId, "dispatched");
        await appendWal({
          workspace,
          op: "inbound_dispatched",
          actor: "inbound-dispatcher",
          payload: {
            drawer_id: drawer.id,
            channel_role: channelRole,
            skill_id: sub.skillId,
            run_id: runId,
          },
        });
        dispatches++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordDispatch(workspace, drawer.id, sub.skillId, runId, "failed", msg);
        await appendWal({
          workspace,
          op: "inbound_dispatch_failed",
          actor: "inbound-dispatcher",
          payload: {
            drawer_id: drawer.id,
            channel_role: channelRole,
            skill_id: sub.skillId,
            error: msg.slice(0, 500),
          },
        });
        failed++;
      }
    }
  }

  return { drawers, dispatches, failed, noSubscriber };
}

export function startInboundDispatcher(
  workspace: string,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      const result = await dispatchPendingInbound(workspace);
      if (result.dispatches > 0 || result.failed > 0) {
        console.log(
          `[nexaas] Inbound dispatcher: ${result.drawers} drawer(s), ` +
          `${result.dispatches} dispatched, ${result.failed} failed, ${result.noSubscriber} no-subscriber`,
        );
      }
    } catch (err) {
      const handled = await reportMissingRelation(workspace, "inbound-dispatcher", err);
      if (!handled) console.error("[nexaas] inbound dispatcher error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Inbound dispatcher started (polling every ${interval / 1000}s)`);
}

export function stopInboundDispatcher(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
