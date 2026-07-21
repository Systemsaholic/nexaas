/**
 * #261 regression tests — the two concurrency-correctness fixes.
 *
 * 1. resolveWaitpoint is atomic: the timeout reaper's auto_approve racing a
 *    human approval must produce exactly ONE successful resolution (the
 *    pre-#261 SELECT-then-UPDATE let both succeed → business action ran
 *    twice). Also workspace-scoped: a signal collision must not resolve
 *    another workspace's waitpoint.
 *
 * 2. upsertEmbedding actually upserts: re-embedding a drawer updates the
 *    one row instead of accumulating duplicates (conflict target was (id),
 *    a gen_random_uuid() that could never conflict).
 *
 * DB-gated like the other [db] suites; uses throwaway workspaces and
 * cleans up after itself.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  getPool, resolveWaitpoint, sql, upsertEmbedding, writeDrawerRaw,
} from "../packages/palace/src/index.js";

const hasDb = !!process.env.DATABASE_URL;
const WS_A = `vitest-261a-${process.pid}`;
const WS_B = `vitest-261b-${process.pid}`;

async function openWaitpoint(workspace: string, signal: string): Promise<string> {
  return writeDrawerRaw(
    workspace,
    { wing: "ops", hall: "test", room: "waitpoints" },
    JSON.stringify({ purpose: "261-race-test" }),
    { dormantSignal: signal, dormantUntil: new Date(Date.now() + 3600_000), runId: randomUUID() },
  );
}

afterAll(async () => {
  if (!hasDb) return;
  await sql(`DELETE FROM nexaas_memory.embeddings WHERE workspace IN ($1, $2)`, [WS_A, WS_B]);
  await sql(`DELETE FROM nexaas_memory.wal WHERE workspace IN ($1, $2)`, [WS_A, WS_B]);
  await sql(`DELETE FROM nexaas_memory.events WHERE workspace IN ($1, $2)`, [WS_A, WS_B]);
  await getPool().end().catch(() => {});
});

describe.skipIf(!hasDb)("resolveWaitpoint atomicity (#261)", () => {
  it("exactly one of N concurrent resolvers wins", async () => {
    const signal = `race-${randomUUID()}`;
    await openWaitpoint(WS_A, signal);

    // The reaper's auto_approve and a human approval, plus stragglers,
    // all firing at once.
    const outcomes = await Promise.allSettled([
      resolveWaitpoint(signal, { decision: "approved", source: "human" }, "human:al", WS_A),
      resolveWaitpoint(signal, { decision: "approved", source: "timeout_auto_approve" }, "system:timeout-reaper", WS_A),
      resolveWaitpoint(signal, { decision: "rejected", source: "human" }, "human:other", WS_A),
      resolveWaitpoint(signal, { decision: "approved", source: "retry" }, "human:al", WS_A),
    ]);

    const wins = outcomes.filter((o) => o.status === "fulfilled");
    const losses = outcomes.filter((o) => o.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(3);
    for (const loss of losses) {
      expect(String((loss as PromiseRejectedResult).reason)).toContain("Waitpoint not found");
    }

    // Exactly one waitpoint_resolved WAL row — the double-execution signal
    // the pre-#261 race produced was two of these.
    const walRows = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM nexaas_memory.wal
        WHERE workspace = $1 AND op = 'waitpoint_resolved'
          AND payload->>'signal' = $2`,
      [WS_A, signal],
    );
    expect(Number(walRows[0]!.n)).toBe(1);
  });

  it("workspace-scoped: does not resolve another workspace's waitpoint", async () => {
    const signal = `collide-${randomUUID()}`;
    const idA = await openWaitpoint(WS_A, signal);
    const idB = await openWaitpoint(WS_B, signal);

    await resolveWaitpoint(signal, { decision: "approved" }, "human:al", WS_A);

    const rows = await sql<{ id: string; dormant_signal: string | null }>(
      `SELECT id, dormant_signal FROM nexaas_memory.events WHERE id IN ($1::uuid, $2::uuid)`,
      [idA, idB],
    );
    const byId = new Map(rows.map((r) => [r.id, r.dormant_signal]));
    expect(byId.get(idA)).toBeNull();          // A resolved
    expect(byId.get(idB)).toBe(signal);        // B untouched

    // B can still be resolved in its own workspace.
    await resolveWaitpoint(signal, { decision: "approved" }, "human:al", WS_B);
  });

  it("unscoped call (no workspace arg) still resolves — library compatibility", async () => {
    const signal = `unscoped-${randomUUID()}`;
    await openWaitpoint(WS_A, signal);
    const result = await resolveWaitpoint(signal, { decision: "approved" }, "human:al");
    expect(result).toBeDefined();
  });
});

describe.skipIf(!hasDb)("upsertEmbedding actually upserts (#261)", () => {
  it("re-embedding a drawer updates the single row", async () => {
    const drawerId = await writeDrawerRaw(
      WS_A, { wing: "knowledge", hall: "test", room: "embed" }, "embed me",
    );
    const room = { wing: "knowledge", hall: "test", room: "embed" };
    const vec = (fill: number) => Array.from({ length: 1024 }, () => fill);

    await upsertEmbedding(WS_A, drawerId, room, vec(0.1), "voyage-3");
    await upsertEmbedding(WS_A, drawerId, room, vec(0.2), "voyage-3-large");
    await upsertEmbedding(WS_A, drawerId, room, vec(0.3), "voyage-3-large");

    const rows = await sql<{ n: string; model: string }>(
      `SELECT count(*) AS n, max(model) AS model FROM nexaas_memory.embeddings WHERE drawer_id = $1::uuid`,
      [drawerId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
    expect(rows[0]!.model).toBe("voyage-3-large");
  });
});
