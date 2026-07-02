-- Migration 029: WAL canonicalization v2 — hash nested payloads (issue #254)
-- Date: 2026-07-02
--
-- The v1 canonicalizer (packages/palace/src/wal.ts) hashed the payload with
-- `JSON.stringify(payload, Object.keys(payload).sort())`. A replacer *array*
-- is a key allowlist applied at EVERY depth, so any nested object serialized
-- as `{}` — nested WAL payload fields could be altered in the database with
-- no change to the hash. Verification was self-consistent (it dropped the
-- same data at recompute), which is why 8.9M+ Phoenix rows never surfaced it.
-- v1 also mis-hashed top-level numbers that JS renders in exponent form.
--
-- Fix without rewriting the append-only chain (the #234 / 028 playbook):
--   * `canon_version` tags each row with the algorithm that produced its
--     hash. Existing rows default to 1 and keep verifying under the v1 JS
--     canonicalizer (bug and all — that is historical fact); new rows are
--     written v2 and verify under wal_hash_v2 below.
--   * wal_hash_v2 is ONE canonical implementation used by BOTH the writer
--     (appendWal) and the verifier. It hashes over `payload::text` — jsonb's
--     deterministic, fully-nested, number-normalized serialization — so the
--     write-time and verify-time inputs are byte-identical by construction,
--     sidestepping every JS-vs-jsonb representation mismatch. Nested tamper
--     now changes payload::text and is detected.
--
-- Additive column + a function + a targeted exempt flag. No history rewrite;
-- rollback to pre-029 code is safe (older code ignores canon_version and
-- recomputes everything with v1 — which then flags v2 rows broken, so DO NOT
-- run pre-029 verify against a v2-written chain; the column is the guard).

ALTER TABLE nexaas_memory.wal
  ADD COLUMN IF NOT EXISTS canon_version smallint NOT NULL DEFAULT 1;

-- Canonical hash, v2. IMMUTABLE so it can be used in indexes/SELECT freely.
-- Input order matches the v1 pipe-join: prev|op|actor|<payload>|created.
CREATE OR REPLACE FUNCTION nexaas_memory.wal_hash_v2(
  prev text, op text, actor text, payload jsonb, created text
) RETURNS text LANGUAGE sql IMMUTABLE AS $func$
  SELECT encode(
    digest(prev || '|' || op || '|' || actor || '|' || payload::text || '|' || created, 'sha256'),
    'hex'
  )
$func$;

-- Flag the pre-#254 raw-CLI WAL writers (library/gdpr/propagate/seed) as
-- integrity-exempt. Those rows were written by hand-rolled INSERTs with a
-- bogus `sha256('<field-json>')` hash — never canonical under ANY version,
-- and with no advisory lock. PR #254 routes those commands through appendWal
-- so NEW rows are canonical v2; these EXISTING rows can't be recomputed, so
-- verify treats them as linkage-only anchors (same as workspace_genesis and
-- the 028 palace_mcp_write rows). Only rows that exist now are flagged; new
-- appendWal-written rows of these ops default to not-exempt and verify.
UPDATE nexaas_memory.wal
   SET integrity_exempt = true
 WHERE integrity_exempt = false
   AND op IN (
     'library_contribute', 'library_promote',
     'library_propagate', 'proposal_accepted',
     'gdpr_export', 'gdpr_delete', 'gdpr_redact',
     'palace_seeded'
   );
