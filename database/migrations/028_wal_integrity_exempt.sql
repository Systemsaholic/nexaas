-- Migration 028: WAL integrity-exempt marker for pre-fix palace_mcp_write rows (#234)
-- Date: 2026-06-19
--
-- The palace MCP `palace_write` tool wrote its WAL rows with
-- hash = sha256('palace-write-' || now-ish) — never the canonical
-- prev_hash|op|actor|payload|created_at — and took no advisory lock. So
-- every existing `palace_mcp_write` row is unverifiable: verifyWalChain
-- recomputes the canonical hash, gets a different value, and reports the
-- chain broken at the first such row (Phoenix: 1009 rows from id 4183,
-- breaking verify-wal --full and the upgrade gate). PR #235 fixed the
-- writer forward (it now uses appendWal); this migration repairs the
-- backlog.
--
-- These rows were NEVER canonically hashed, so we cannot recompute them —
-- and we will not rewrite the append-only chain. Instead we mark them
-- integrity-exempt: verifyWalChain skips hash *recomputation* for flagged
-- rows (exactly as it already does for the workspace_genesis anchor) while
-- still verifying their prev_hash *linkage*. Honest about what was never
-- protected; rewrites no history; forward-safe — post-#235 palace_mcp_write
-- rows are written by appendWal, are NOT flagged, and are fully verified.
--
-- Additive column with a constant default = metadata-only on PG 11+ (no
-- table rewrite, important on Phoenix's ~11.5M-row wal). Rollback to v0.3.3
-- is safe: older code simply never reads the column.

ALTER TABLE nexaas_memory.wal
  ADD COLUMN IF NOT EXISTS integrity_exempt boolean NOT NULL DEFAULT false;

-- Flag the existing buggy backlog. Only rows that already exist now (all
-- written by the pre-#235 inline INSERT) are flagged; new appendWal-written
-- palace_mcp_write rows default to false and verify normally.
UPDATE nexaas_memory.wal
   SET integrity_exempt = true
 WHERE op = 'palace_mcp_write'
   AND integrity_exempt = false;
