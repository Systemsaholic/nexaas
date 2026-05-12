/**
 * Batch trigger dispatcher (#80).
 *
 * Accumulates drawers in `batch.<bucket>.pending.*` rooms; fires a consumer
 * skill once the bucket's `fire_when` conditions are met. Sibling primitive
 * to the inbound and notification dispatchers — same poll-claim-dispatch
 * skeleton, just keyed on (bucket, fire_when) instead of (drawer_id) or
 * (idempotency_key).
 *
 * Manifest declaration on the consumer skill:
 *
 *   triggers:
 *     - type: batch
 *       bucket: alerts.critical
 *       fire_when:
 *         any_of:
 *           - count_at_least: 10
 *           - oldest_age_at_least: "1h"
 *           - cron: "0 9 * * MON"
 *           - at: "2026-05-15T00:00:00Z"
 *       on_empty: skip                    # default
 *       ordering: arrival                 # default
 *
 * Producer side: anything that wants to contribute to the batch writes a
 * drawer to `batch.<bucket>.pending.<arbitrary-id>`. Drawer payload is
 * opaque to the framework — the consumer skill defines the schema.
 *
 * Dispatch path each poll:
 *   1. Build / refresh the bucket → consumer index from skill manifests.
 *   2. For each known bucket, count pending items and check fire_when.
 *   3. If any condition matches, atomically claim a batch_id with the
 *      current pending item ids, then enqueue a `skill-step` BullMQ job
 *      with `triggerPayload.batch_items: [{drawer_id, content, created_at}]`.
 *   4. On consumer success the items get archived. On failure the dispatch
 *      row is marked failed; the items stay pending and the bucket re-evaluates
 *      on the next poll. (Item-level dedup falls out of using drawer_id arrays.)
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { load as yamlLoad } from "js-yaml";
import { sql, appendWal } from "@nexaas/palace";
import cronParser from "cron-parser";
import { enqueueSkillStep, type SkillJobData } from "../bullmq/queues.js";
// Once #77 (silent migration drift) merges, switch the catch in
// startBatchDispatcher to call reportMissingRelation from
// `./_consistency-warning.js` so a missing batch_dispatches table emits
// `framework_consistency_warning` exactly once instead of console.error
// per tick. Until then we just console.error to stay rebase-clean.

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const INDEX_TTL_MS = 30_000;
const MAX_BATCH_SIZE = 1_000;            // safety cap so a runaway producer can't OOM the consumer

interface BatchManifest {
  id: string;
  version?: string;
  execution?: { type?: string };
  triggers?: Array<{
    type: string;
    bucket?: string;
    fire_when?: {
      any_of?: Array<Record<string, unknown>>;
    };
    on_empty?: "skip" | "fire-with-empty";
    ordering?: "arrival" | "recency-first";
  }>;
}

interface BatchTriggerSubscriber {
  skillId: string;
  manifestPath: string;
  execType: "ai-exec" | "shell-exec";
  conditions: BatchCondition[];
  onEmpty: "skip" | "fire-with-empty";
  ordering: "arrival" | "recency-first";
}

type BatchCondition =
  | { kind: "count_at_least"; n: number }
  | { kind: "oldest_age_at_least"; seconds: number }
  | { kind: "cron"; expression: string; lastEvaluatedAt: number }
  | { kind: "at"; iso: string }
  /**
   * Per-item deadline (#136). `field` names a top-level key in drawer
   * content (parsed as JSON). The dispatcher reads each pending drawer's
   * value at that key, parses as ISO 8601, and fires the item individually
   * once its deadline is past. Unlike the bucket-wide conditions, this
   * fires one batch per due drawer (item_drawer_ids length-1), letting
   * skills declare per-payload scheduled actions without a polling skill.
   */
  | { kind: "at_from_field"; field: string };

/** bucket → subscribers (only one supported in v1; flagged in #80 follow-up) */
type BatchIndex = Map<string, BatchTriggerSubscriber>;

interface CachedIndex {
  index: BatchIndex;
  builtAt: number;
}

let _cached: CachedIndex | null = null;
let _polling = false;
let _interval: NodeJS.Timeout | null = null;

const AGE_PATTERN = /^(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours|d|day|days)?$/i;
function parseAgeSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const m = value.trim().match(AGE_PATTERN);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit.startsWith("s")) return n;
  if (unit.startsWith("min") || unit === "m") return n * 60;
  if (unit.startsWith("h")) return n * 3600;
  if (unit.startsWith("d")) return n * 86400;
  return n;
}

function parseCondition(raw: Record<string, unknown>): BatchCondition | null {
  if ("count_at_least" in raw) {
    const n = Number(raw.count_at_least);
    if (!Number.isFinite(n) || n < 1) return null;
    return { kind: "count_at_least", n: Math.floor(n) };
  }
  if ("oldest_age_at_least" in raw) {
    const seconds = parseAgeSeconds(raw.oldest_age_at_least);
    if (seconds == null) return null;
    return { kind: "oldest_age_at_least", seconds };
  }
  if ("cron" in raw) {
    const expression = typeof raw.cron === "string" ? raw.cron.trim() : "";
    if (!expression) return null;
    try { cronParser.parseExpression(expression); } catch { return null; }
    return { kind: "cron", expression, lastEvaluatedAt: Date.now() };
  }
  if ("at" in raw) {
    const iso = typeof raw.at === "string" ? raw.at : "";
    if (!iso || !Number.isFinite(Date.parse(iso))) return null;
    return { kind: "at", iso };
  }
  if ("at_from_field" in raw) {
    const field = typeof raw.at_from_field === "string" ? raw.at_from_field.trim() : "";
    // Constrain to a plain identifier — no JSONPath, no nested traversal.
    // Keeps the schema validatable + the SQL ->> path simple. The 95% case
    // is a single top-level field like "scheduled_for"; nested paths can
    // ship in a follow-up if a real adopter asks (per issue §"Why this matters").
    if (!field || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return null;
    return { kind: "at_from_field", field };
  }
  return null;
}

/**
 * Extract a per-item deadline from a drawer's JSON content (#136). Returns
 * the epoch ms when the item is due, or null when the field is missing /
 * unparseable / not a valid timestamp. Pure — no SQL.
 */
export function extractItemDeadlineMs(content: string, field: string): number | null {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const v = (parsed as Record<string, unknown>)[field];
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

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

function buildBatchIndex(skillsRoot: string): BatchIndex {
  const index: BatchIndex = new Map();
  for (const manifestPath of findSkillManifests(skillsRoot)) {
    let manifest: BatchManifest;
    try {
      manifest = yamlLoad(readFileSync(manifestPath, "utf-8")) as BatchManifest;
    } catch {
      continue;
    }
    const batchTriggers = (manifest.triggers ?? []).filter(
      (t) => t.type === "batch" && typeof t.bucket === "string" && t.bucket.length > 0,
    );
    if (batchTriggers.length === 0) continue;
    const execType = manifest.execution?.type === "ai-skill" ? "ai-exec" : "shell-exec";

    for (const trigger of batchTriggers) {
      const bucket = trigger.bucket!;
      if (index.has(bucket)) {
        // v1 constraint: one consumer per bucket. Multi-consumer fan-out is
        // tracked in the #80 issue under "open design questions".
        console.warn(
          `[nexaas] batch-dispatcher: bucket '${bucket}' already claimed by ` +
          `${index.get(bucket)!.skillId}; ignoring duplicate from ${manifest.id}`,
        );
        continue;
      }
      const conditionsRaw = trigger.fire_when?.any_of ?? [];
      const conditions: BatchCondition[] = [];
      for (const c of conditionsRaw) {
        const parsed = parseCondition(c);
        if (parsed) conditions.push(parsed);
        else console.warn(`[nexaas] batch-dispatcher: ignoring unparseable fire_when in ${manifest.id}: ${JSON.stringify(c)}`);
      }
      if (conditions.length === 0) {
        console.warn(`[nexaas] batch-dispatcher: skill ${manifest.id} bucket ${bucket} has no parseable fire_when conditions; skipping`);
        continue;
      }
      index.set(bucket, {
        skillId: manifest.id,
        manifestPath,
        execType,
        conditions,
        onEmpty: trigger.on_empty === "fire-with-empty" ? "fire-with-empty" : "skip",
        ordering: trigger.ordering === "recency-first" ? "recency-first" : "arrival",
      });
    }
  }
  return index;
}

function getBatchIndex(): BatchIndex {
  const workspaceRoot = process.env.NEXAAS_WORKSPACE_ROOT;
  if (!workspaceRoot) return new Map();
  const now = Date.now();
  if (_cached && now - _cached.builtAt < INDEX_TTL_MS) return _cached.index;
  const index = buildBatchIndex(join(workspaceRoot, "nexaas-skills"));
  _cached = { index, builtAt: now };
  return index;
}

export function invalidateBatchIndex(): void {
  _cached = null;
}

interface PendingItem {
  id: string;
  content: string;
  created_at: string;
}

async function selectPendingItems(
  workspace: string,
  bucket: string,
  ordering: "arrival" | "recency-first",
  limit: number,
): Promise<PendingItem[]> {
  const direction = ordering === "recency-first" ? "DESC" : "ASC";
  return await sql<PendingItem>(
    `SELECT id::text AS id, content, created_at::text AS created_at
       FROM nexaas_memory.events e
      WHERE e.workspace = $1
        AND e.wing = 'batch'
        AND e.hall = $2
        AND e.room LIKE 'pending.%'
        AND e.dormant_signal IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM nexaas_memory.batch_dispatches d
           WHERE d.workspace = e.workspace
             AND d.bucket = $2
             AND d.status IN ('claimed', 'dispatched', 'completed')
             AND e.id::uuid = ANY (d.item_drawer_ids)
        )
      ORDER BY e.created_at ${direction}
      LIMIT $3`,
    [workspace, bucket, limit],
  );
}

interface FireDecision {
  fire: boolean;
  reason: string;
}

function evaluateFireWhen(items: PendingItem[], sub: BatchTriggerSubscriber, now: number): FireDecision {
  if (items.length === 0 && sub.onEmpty === "skip") {
    // Even if a cron / at condition matches, skip empty fires per default.
    // fire-with-empty consumers explicitly opt into the noisy behavior.
    // We still need to advance cron's lastEvaluatedAt below so we don't
    // re-fire on every tick once a deadline passes.
    for (const c of sub.conditions) {
      if (c.kind === "cron") c.lastEvaluatedAt = now;
    }
    return { fire: false, reason: "empty_skipped" };
  }

  for (const c of sub.conditions) {
    switch (c.kind) {
      case "count_at_least":
        if (items.length >= c.n) return { fire: true, reason: `count_at_least:${c.n}` };
        break;
      case "oldest_age_at_least": {
        const oldest = items[items.length - 1] ?? items[0];
        // For arrival ordering, items[0] is oldest; for recency-first, items[length-1].
        // We always want the oldest pending item — easier to recompute than reason about ordering here.
        const oldestAt = items.reduce((acc, i) => {
          const t = Date.parse(i.created_at);
          return Number.isFinite(t) && t < acc ? t : acc;
        }, Number.POSITIVE_INFINITY);
        if (Number.isFinite(oldestAt) && (now - oldestAt) >= c.seconds * 1000) {
          return { fire: true, reason: `oldest_age_at_least:${c.seconds}s` };
        }
        // suppress unused warning
        void oldest;
        break;
      }
      case "cron": {
        // Did the cron expression match between lastEvaluatedAt and now?
        try {
          const interval = cronParser.parseExpression(c.expression, {
            currentDate: new Date(c.lastEvaluatedAt),
            endDate: new Date(now),
          });
          let matched = false;
          // iterator throws once it runs out of matches in the [current, end] window
          while (true) {
            try { interval.next(); matched = true; } catch { break; }
          }
          c.lastEvaluatedAt = now;
          if (matched) return { fire: true, reason: `cron:${c.expression}` };
        } catch (err) {
          console.warn(`[nexaas] batch-dispatcher: cron eval failed for ${c.expression}: ${(err as Error).message}`);
        }
        break;
      }
      case "at": {
        const dueAt = Date.parse(c.iso);
        if (Number.isFinite(dueAt) && dueAt <= now) return { fire: true, reason: `at:${c.iso}` };
        break;
      }
      case "at_from_field":
        // Per-item condition (#136) — handled separately by findPerItemDue
        // before this function is called. evaluateFireWhen only decides on
        // bucket-wide fires; per-item firing fires one batch per drawer.
        break;
    }
  }
  return { fire: false, reason: "no_condition_matched" };
}

/**
 * Return the subset of pending items that are individually due per any
 * `at_from_field` condition on the subscriber (#136). Items returned here
 * fire as length-1 batches; the bucket-wide evaluator then runs on the
 * remainder for any other conditions in the same `any_of` block.
 */
export function findPerItemDue(
  items: PendingItem[],
  sub: BatchTriggerSubscriber,
  now: number,
): Array<{ item: PendingItem; field: string }> {
  const fieldConds = sub.conditions.filter(
    (c): c is { kind: "at_from_field"; field: string } => c.kind === "at_from_field",
  );
  if (fieldConds.length === 0) return [];

  const out: Array<{ item: PendingItem; field: string }> = [];
  for (const item of items) {
    for (const c of fieldConds) {
      const dueAt = extractItemDeadlineMs(item.content, c.field);
      if (dueAt !== null && dueAt <= now) {
        out.push({ item, field: c.field });
        break; // one match is enough — don't double-fire when multiple
               // at_from_field conditions are declared (rare but defensible)
      }
    }
  }
  return out;
}

async function claimBatch(
  workspace: string,
  bucket: string,
  skillId: string,
  itemIds: string[],
  fireReason: string,
): Promise<string | null> {
  const batchId = randomUUID();
  try {
    const rows = await sql<{ batch_id: string }>(
      `INSERT INTO nexaas_memory.batch_dispatches
        (workspace, bucket, batch_id, skill_id, status, item_drawer_ids, fire_reason)
       VALUES ($1, $2, $3, $4, 'claimed', $5::uuid[], $6)
       RETURNING batch_id::text`,
      [workspace, bucket, batchId, skillId, itemIds, fireReason],
    );
    return rows[0]?.batch_id ?? null;
  } catch (err) {
    // Likely an item_drawer_ids overlap with an in-flight batch (see the
    // NOT EXISTS in selectPendingItems). Surface and skip — items will
    // re-appear on the next poll once the prior batch completes/fails.
    await appendWal({
      workspace,
      op: "batch_claim_failed",
      actor: "batch-dispatcher",
      payload: { bucket, skill_id: skillId, error: (err as Error).message.slice(0, 200) },
    }).catch(() => { /* best effort */ });
    return null;
  }
}

async function markDispatched(workspace: string, batchId: string): Promise<void> {
  await sql(
    `UPDATE nexaas_memory.batch_dispatches
        SET status = 'dispatched', dispatched_at = now()
      WHERE workspace = $1 AND batch_id = $2`,
    [workspace, batchId],
  );
}

/**
 * Claim + enqueue a single batch. Shared between bucket-wide firing
 * and per-item (`at_from_field`) firing. Returns true on success.
 */
async function claimAndDispatch(
  workspace: string,
  bucket: string,
  sub: BatchTriggerSubscriber,
  itemsForBatch: PendingItem[],
  fireReason: string,
): Promise<boolean> {
  const itemIds = itemsForBatch.map((i) => i.id);
  const batchId = await claimBatch(workspace, bucket, sub.skillId, itemIds, fireReason);
  if (!batchId) return false;

  const runId = randomUUID();
  const jobData: SkillJobData & { manifestPath?: string } = {
    workspace,
    runId,
    skillId: sub.skillId,
    stepId: sub.execType,
    triggerType: "batch",
    triggerPayload: {
      bucket,
      batch_id: batchId,
      fire_reason: fireReason,
      items: itemsForBatch.map((i) => ({
        drawer_id: i.id,
        content: i.content,
        created_at: i.created_at,
      })),
    },
    manifestPath: sub.manifestPath,
  };

  try {
    await enqueueSkillStep(jobData);
    await markDispatched(workspace, batchId);
    await appendWal({
      workspace,
      op: "batch_dispatched",
      actor: "batch-dispatcher",
      payload: {
        bucket,
        batch_id: batchId,
        skill_id: sub.skillId,
        run_id: runId,
        fire_reason: fireReason,
        item_count: itemsForBatch.length,
      },
    });
    return true;
  } catch (err) {
    // Enqueue failed AFTER claim — leave the dispatch in 'claimed' so it's
    // visible; reaper / operator can clear it. The items remain associated
    // via item_drawer_ids so they don't re-fire under another batch_id.
    await sql(
      `UPDATE nexaas_memory.batch_dispatches
          SET status = 'failed', last_error = $3
        WHERE workspace = $1 AND batch_id = $2`,
      [workspace, batchId, (err as Error).message.slice(0, 1000)],
    ).catch(() => { /* best effort */ });
    await appendWal({
      workspace,
      op: "batch_consumer_failed",
      actor: "batch-dispatcher",
      payload: { bucket, batch_id: batchId, error: (err as Error).message.slice(0, 200) },
    }).catch(() => { /* best effort */ });
    return false;
  }
}

export async function dispatchPendingBatches(workspace: string): Promise<{
  evaluated: number;
  fired: number;
  skipped: number;
}> {
  const index = getBatchIndex();
  let evaluated = 0, fired = 0, skipped = 0;
  const now = Date.now();

  for (const [bucket, sub] of index) {
    evaluated++;
    const items = await selectPendingItems(workspace, bucket, sub.ordering, MAX_BATCH_SIZE);

    // Per-item due (#136) — fire one length-1 batch per drawer whose
    // `at_from_field` deadline has passed. Bucket-wide evaluation then
    // runs on the remainder for any other `any_of` conditions.
    const perItemDue = findPerItemDue(items, sub, now);
    const perItemFiredIds = new Set<string>();
    for (const due of perItemDue) {
      const ok = await claimAndDispatch(
        workspace, bucket, sub, [due.item],
        `at_from_field:${due.field}`,
      );
      if (ok) {
        fired++;
        perItemFiredIds.add(due.item.id);
      } else {
        skipped++;
      }
    }

    const remaining = perItemFiredIds.size === 0
      ? items
      : items.filter((i) => !perItemFiredIds.has(i.id));

    const decision = evaluateFireWhen(remaining, sub, now);
    if (!decision.fire) {
      if (perItemDue.length === 0) skipped++;
      continue;
    }

    const ok = await claimAndDispatch(workspace, bucket, sub, remaining, decision.reason);
    if (ok) fired++;
    else skipped++;
  }

  return { evaluated, fired, skipped };
}

export function startBatchDispatcher(
  workspace: string,
  opts: { intervalMs?: number } = {},
): void {
  if (_interval) return;
  const interval = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  _interval = setInterval(async () => {
    if (_polling) return;
    _polling = true;
    try {
      const result = await dispatchPendingBatches(workspace);
      if (result.fired > 0) {
        console.log(
          `[nexaas] Batch dispatcher: ${result.evaluated} bucket(s), ${result.fired} fired, ${result.skipped} skipped`,
        );
      }
    } catch (err) {
      console.error("[nexaas] batch dispatcher error:", err);
    } finally {
      _polling = false;
    }
  }, interval);
  _interval.unref?.();

  console.log(`[nexaas] Batch dispatcher started (polling every ${interval / 1000}s)`);
}

export function stopBatchDispatcher(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
