import { createHash } from "crypto";
import { sql, sqlInTransaction } from "./db.js";

export interface WalEntry {
  workspace: string;
  op: string;
  actor: string;
  payload: Record<string, unknown>;
  signedByKeyId?: string;
  signature?: Buffer;
}

function canonicalize(entry: WalEntry, createdAt: string, prevHash: string): string {
  const parts = [prevHash, entry.op, entry.actor, JSON.stringify(entry.payload, Object.keys(entry.payload).sort()), createdAt];
  return parts.join("|");
}

function computeHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

const GENESIS_HASH = "0".repeat(64);

export async function appendWal(entry: WalEntry): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Wrap SELECT+INSERT in a single transaction gated by a per-workspace
      // advisory lock. Previously the SELECT and INSERT ran as separate
      // autocommit statements, so the `FOR UPDATE` lock released the moment
      // the SELECT completed — two concurrent callers would both read the
      // same "latest" row and insert rows sharing a prev_hash, forking the
      // chain. The advisory lock serializes all appendWal calls for the
      // same workspace; it releases automatically on COMMIT/ROLLBACK.
      // Different workspaces don't block each other. See #71.
      await sqlInTransaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('nexaas:wal:' || $1::text, 0))",
          [entry.workspace],
        );

        const prevResult = await client.query<{ hash: string }>(
          `SELECT hash FROM nexaas_memory.wal
           WHERE workspace = $1
           ORDER BY id DESC
           LIMIT 1`,
          [entry.workspace],
        );

        const prevHash = prevResult.rows[0]?.hash ?? GENESIS_HASH;
        const createdAt = new Date().toISOString();
        const canonical = canonicalize(entry, createdAt, prevHash);
        const hash = computeHash(canonical);

        const signedContentHash = entry.signature
          ? computeHash(canonical)
          : null;

        await client.query(
          `INSERT INTO nexaas_memory.wal
            (workspace, op, actor, payload, prev_hash, hash,
             signed_by_key_id, signature, signed_content_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            entry.workspace, entry.op, entry.actor,
            JSON.stringify(entry.payload),
            prevHash, hash,
            entry.signedByKeyId ?? null,
            entry.signature ?? null,
            signedContentHash,
            createdAt,
          ],
        );
      });

      return;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505" && attempt < maxRetries - 1) {
        continue;
      }
      throw err;
    }
  }
}

export async function verifyWalChain(
  workspace: string,
  fromId?: number,
): Promise<{ valid: boolean; brokenAt?: number; error?: string }> {
  const condition = fromId ? `AND id >= $2` : "";
  const params: unknown[] = [workspace];
  if (fromId) params.push(fromId);

  const rows = await sql<{
    id: number;
    op: string;
    actor: string;
    payload: Record<string, unknown>;
    prev_hash: string;
    hash: string;
    created_at: string;
  }>(
    // to_char the timestamp into the exact shape `new Date().toISOString()`
    // produced at write time. Postgres' default `::text` cast uses
    // "2026-04-22 11:15:00.094+00" which differs byte-for-byte from
    // "2026-04-22T11:15:00.094Z" — the hash input the row was built with —
    // so the default formatting always fails recomputation. See #70.
    `SELECT id, op, actor, payload, prev_hash, hash,
            to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
     FROM nexaas_memory.wal
     WHERE workspace = $1 ${condition}
     ORDER BY id ASC`,
    params,
  );

  let expectedPrevHash = fromId ? undefined : GENESIS_HASH;

  for (const row of rows) {
    if (expectedPrevHash !== undefined && row.prev_hash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAt: row.id,
        error: `prev_hash mismatch at id ${row.id}: expected ${expectedPrevHash}, got ${row.prev_hash}`,
      };
    }

    // The `workspace_genesis` row is written by `nexaas init` via raw SQL
    // (not through appendWal), so its hash was not produced by canonicalize().
    // It serves as the chain's trust anchor — integrity for subsequent rows
    // comes from prev_hash linkage, not from re-deriving the anchor. Verify
    // the anchor exists and links correctly, but skip hash recomputation.
    // See #70 for the longer explanation.
    if (row.op !== "workspace_genesis") {
      const canonical = canonicalize(
        { workspace, op: row.op, actor: row.actor, payload: row.payload },
        row.created_at,
        row.prev_hash,
      );
      const recomputed = computeHash(canonical);

      if (recomputed !== row.hash) {
        return {
          valid: false,
          brokenAt: row.id,
          error: `hash mismatch at id ${row.id}: expected ${recomputed}, got ${row.hash}`,
        };
      }
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true };
}
