/**
 * #239 — post-restart straggler repair. DB-gated. Builds a real per-workspace
 * WAL chain, injects a pre-#235-style bogus `palace_mcp_write` row (bogus
 * hash, canon v1 — exactly what a still-running old MCP wrote in the
 * migrate→restart window), and proves the repair flags it, keeps the chain
 * strict for everything else, and respects the restart cutoff.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendWal, getPool, repairMcpStragglers, sql, verifyWalChain,
} from "../packages/palace/src/index.js";

const hasDb = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!hasDb) return;
  await sql(`DELETE FROM nexaas_memory.wal WHERE workspace LIKE 'vitest-239-%'`, []);
  await getPool().end().catch(() => {});
});

async function seedChain(ws: string): Promise<void> {
  await appendWal({ workspace: ws, op: "seed", actor: "t", payload: { n: 1 } });
  await appendWal({ workspace: ws, op: "seed", actor: "t", payload: { n: 2 } });
}

/** Inject a row exactly as the pre-#235 MCP did: bogus hash, no canon. */
async function injectBogus(ws: string, op: string, createdAt?: string): Promise<number> {
  const prev = (await sql<{ hash: string }>(
    `SELECT hash FROM nexaas_memory.wal WHERE workspace = $1 ORDER BY id DESC LIMIT 1`, [ws],
  ))[0]!.hash;
  const rows = await sql<{ id: number }>(
    `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, prev_hash, hash, canon_version${createdAt ? ", created_at" : ""})
     VALUES ($1, $2, 'palace-mcp', '{"x":1}'::jsonb, $3,
             encode(digest('palace-write-' || now()::text || random()::text, 'sha256'), 'hex'), 1${createdAt ? `, '${createdAt}'::timestamptz` : ""})
     RETURNING id`,
    [ws, op, prev],
  );
  return rows[0]!.id;
}

describe.skipIf(!hasDb)("repairMcpStragglers (#239)", () => {
  it("flags a pre-restart bogus palace_mcp_write straggler; chain verifies after", async () => {
    const ws = `vitest-239-${randomUUID().slice(0, 8)}`;
    await seedChain(ws);
    const bogusId = await injectBogus(ws, "palace_mcp_write");
    await appendWal({ workspace: ws, op: "seed", actor: "t", payload: { n: 3 } });

    expect((await verifyWalChain(ws)).valid).toBe(false);

    const cutoff = new Date(Date.now() + 5_000); // restart happened after the write
    const result = await repairMcpStragglers(ws, cutoff);
    expect(result.valid).toBe(true);
    expect(result.flagged).toEqual([bogusId]);

    const after = await verifyWalChain(ws);
    expect(after.valid).toBe(true);
    expect(after.exemptSkipped).toBeGreaterThanOrEqual(1);

    // The repair itself is WAL-audited.
    const audit = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM nexaas_memory.wal
        WHERE workspace = $1 AND op = 'wal_exempt_straggler_flagged'
          AND (payload->>'id')::int = $2`,
      [ws, bogusId],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it("refuses a broken row with a different op — real corruption stays loud", async () => {
    const ws = `vitest-239-${randomUUID().slice(0, 8)}`;
    await seedChain(ws);
    const bogusId = await injectBogus(ws, "library_contribute");

    const result = await repairMcpStragglers(ws, new Date(Date.now() + 5_000));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(bogusId);
    expect(result.flagged).toEqual([]);

    const row = await sql<{ integrity_exempt: boolean }>(
      `SELECT integrity_exempt FROM nexaas_memory.wal WHERE id = $1`, [bogusId],
    );
    expect(row[0]!.integrity_exempt).toBe(false);
  });

  it("refuses a palace_mcp_write row written AFTER the restart cutoff", async () => {
    const ws = `vitest-239-${randomUUID().slice(0, 8)}`;
    await seedChain(ws);
    const bogusId = await injectBogus(ws, "palace_mcp_write");

    // Restart happened a minute ago; this row post-dates it — the forward
    // fix (#235) means a post-restart bogus write is NOT a straggler.
    const result = await repairMcpStragglers(ws, new Date(Date.now() - 60_000));
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(bogusId);
    expect(result.flagged).toEqual([]);
  });

  it("multiple stragglers all flagged in one pass", async () => {
    const ws = `vitest-239-${randomUUID().slice(0, 8)}`;
    await seedChain(ws);
    const a = await injectBogus(ws, "palace_mcp_write");
    await appendWal({ workspace: ws, op: "seed", actor: "t", payload: { n: 4 } });
    const b = await injectBogus(ws, "palace_mcp_write");

    const result = await repairMcpStragglers(ws, new Date(Date.now() + 5_000));
    expect(result.valid).toBe(true);
    expect(result.flagged).toEqual([a, b]);
    expect((await verifyWalChain(ws)).valid).toBe(true);
  });
});
