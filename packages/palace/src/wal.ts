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

/**
 * v1 canonicalizer — RETAINED ONLY to verify pre-#254 rows (`canon_version`
 * defaults to 1). It is buggy by design-fact: the `JSON.stringify(payload,
 * sortedTopKeys)` replacer-array filters keys at every depth, so nested
 * payload objects serialize as `{}` (nested tamper is invisible). We do NOT
 * fix this — v1 rows were hashed with exactly this, and must be recomputed
 * with exactly this to verify. New rows are written v2 (wal_hash_v2 in the
 * DB, hashing over jsonb `payload::text`). See #254 / migration 029.
 */
function canonicalizeV1(entry: WalEntry, createdAt: string, prevHash: string): string {
  const parts = [prevHash, entry.op, entry.actor, JSON.stringify(entry.payload, Object.keys(entry.payload).sort()), createdAt];
  return parts.join("|");
}

function computeHash(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

const GENESIS_HASH = "0".repeat(64);

/** Current canonicalization epoch new rows are written with. */
const CANON_VERSION = 2;

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

        // v2 hash (#254): computed in SQL by wal_hash_v2 over `payload::text`
        // (jsonb's deterministic, fully-nested serialization) so the write-
        // time and verify-time hash inputs are byte-identical by construction.
        // The payload param ($4) is cast to jsonb and passed to the function;
        // signed_content_hash mirrors the hash only when a signature is
        // supplied (signing is scaffolding today — see verifyWalChain notes).
        await client.query(
          `INSERT INTO nexaas_memory.wal
            (workspace, op, actor, payload, prev_hash, hash, canon_version,
             signed_by_key_id, signature, signed_content_hash, created_at)
           VALUES (
             $1, $2, $3, $4::jsonb, $5,
             nexaas_memory.wal_hash_v2($5, $2, $3, $4::jsonb, $6),
             $7::smallint, $8, $9,
             CASE WHEN $9::bytea IS NOT NULL
                  THEN nexaas_memory.wal_hash_v2($5, $2, $3, $4::jsonb, $6)
                  ELSE NULL END,
             $6::timestamptz
           )`,
          [
            entry.workspace, entry.op, entry.actor,
            JSON.stringify(entry.payload),
            prevHash, createdAt, CANON_VERSION,
            entry.signedByKeyId ?? null,
            entry.signature ?? null,
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

/**
 * Rows verified per round-trip. Verification streams the chain in keyset-
 * paginated batches instead of materializing every row: a production WAL
 * (Phoenix: 1.34M+ rows with jsonb payloads) loaded as one array exhausts
 * the V8 heap — found live when the v0.3.1 canary's conformance wal-chain
 * check OOM-crashed node on Phoenix. Memory is now bounded by one batch.
 */
const VERIFY_BATCH_SIZE = 5000;

type WalVerifyRow = {
  id: number;
  op: string;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  created_at: string;
  integrity_exempt: boolean;
  canon_version: number;
  // For canon_version >= 2, the DB recomputes the hash inline via
  // wal_hash_v2 (over jsonb payload::text) so verification never has to
  // reproduce jsonb's serialization in JS. NULL for v1 rows (recomputed in
  // JS via canonicalizeV1 instead). See #254.
  recomputed_v2: string | null;
};

export async function verifyWalChain(
  workspace: string,
  fromId?: number,
): Promise<{ valid: boolean; brokenAt?: number; error?: string; exemptSkipped?: number }> {
  // Keyset cursor: `id > lastId` reproduces the original `id >= fromId`
  // window when seeded with fromId - 1, and genesis-to-tip when seeded 0.
  let lastId = fromId ? fromId - 1 : 0;
  let expectedPrevHash = fromId ? undefined : GENESIS_HASH;
  let exemptSkipped = 0;

  for (;;) {
    const rows = await sql<WalVerifyRow>(
      // to_char the timestamp into the exact shape `new Date().toISOString()`
      // produced at write time. Postgres' default `::text` cast uses
      // "2026-04-22 11:15:00.094+00" which differs byte-for-byte from
      // "2026-04-22T11:15:00.094Z" — the hash input the row was built with —
      // so the default formatting always fails recomputation. See #70.
      `SELECT id, op, actor, payload, prev_hash, hash,
              to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
              integrity_exempt, canon_version,
              CASE WHEN canon_version >= 2
                   THEN nexaas_memory.wal_hash_v2(
                          prev_hash, op, actor, payload,
                          to_char(created_at AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   ELSE NULL END AS recomputed_v2
       FROM nexaas_memory.wal
       WHERE workspace = $1 AND id > $2
       ORDER BY id ASC
       LIMIT ${VERIFY_BATCH_SIZE}`,
      [workspace, lastId],
    );
    if (rows.length === 0) break;

    const verdict = verifyBatch(workspace, rows, expectedPrevHash);
    if (verdict.broken) return verdict.broken;
    exemptSkipped += verdict.exemptSkipped;

    expectedPrevHash = rows[rows.length - 1]!.hash;
    lastId = rows[rows.length - 1]!.id;
    if (rows.length < VERIFY_BATCH_SIZE) break;
  }

  return { valid: true, exemptSkipped };
}

function verifyBatch(
  workspace: string,
  rows: WalVerifyRow[],
  startPrevHash: string | undefined,
): { broken: { valid: false; brokenAt: number; error: string } | null; exemptSkipped: number } {
  let expectedPrevHash = startPrevHash;
  let exemptSkipped = 0;

  for (const row of rows) {
    if (expectedPrevHash !== undefined && row.prev_hash !== expectedPrevHash) {
      return {
        broken: {
          valid: false,
          brokenAt: row.id,
          error: `prev_hash mismatch at id ${row.id}: expected ${expectedPrevHash}, got ${row.prev_hash}`,
        },
        exemptSkipped,
      };
    }

    // Hash recomputation is skipped for two kinds of trust-anchor rows whose
    // stored hash was provably not produced by the canonicalizer:
    //   - `workspace_genesis`: written by `nexaas init` via raw SQL as the
    //     chain's root anchor (see #70).
    //   - `integrity_exempt` rows: pre-#234 palace_mcp_write (migration 028)
    //     and pre-#254 raw-CLI writers (migration 029), whose stored hash was
    //     never canonical under any version. We never claimed integrity for
    //     them and won't rewrite the append-only chain to fake it.
    // Everything else recomputes under the algorithm its `canon_version`
    // declares: v2 rows (#254) are recomputed by the DB via wal_hash_v2
    // (over jsonb payload::text — nested tamper is detected); v1 rows use the
    // historical JS canonicalizeV1. Both still have prev_hash linkage checked
    // above regardless.
    if (row.integrity_exempt) {
      exemptSkipped++;
    } else if (row.op !== "workspace_genesis") {
      const recomputed = row.canon_version >= 2
        ? row.recomputed_v2 ?? ""
        : computeHash(canonicalizeV1(
            { workspace, op: row.op, actor: row.actor, payload: row.payload },
            row.created_at,
            row.prev_hash,
          ));

      if (recomputed !== row.hash) {
        return {
          broken: {
            valid: false,
            brokenAt: row.id,
            error: `hash mismatch at id ${row.id} (canon v${row.canon_version}): expected ${recomputed}, got ${row.hash}`,
          },
          exemptSkipped,
        };
      }
    }

    expectedPrevHash = row.hash;
  }

  return { broken: null, exemptSkipped };
}
