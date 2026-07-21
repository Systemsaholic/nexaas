-- 030: one embedding per drawer (#261)
--
-- upsertEmbedding declared `ON CONFLICT (id) DO UPDATE` where id defaults
-- to gen_random_uuid() — the conflict could never fire and there was no
-- unique constraint on drawer_id, so re-embedding a drawer accumulated
-- duplicate rows (skewed RAG similarity, bloated the HNSW index). Dedupe
-- (keep the newest embedding per drawer), then enforce uniqueness so the
-- code's corrected `ON CONFLICT (drawer_id)` target works.
--
-- Rollback compatibility (one release, per docs/releases.md): prior-release
-- code only writes embeddings through the Voyage-gated ingest embedder,
-- which has never run in production (embeddings is empty fleet-wide at
-- migration time — verified on Phoenix 2026-07-21). A rolled-back writer
-- re-embedding the same drawer would now error instead of silently
-- duplicating; with zero live writers this is theoretical, and the write
-- it would block is precisely the bug.

-- Dedupe: keep the newest row per drawer_id.
DELETE FROM nexaas_memory.embeddings e
 USING nexaas_memory.embeddings newer
 WHERE newer.drawer_id = e.drawer_id
   AND (newer.created_at > e.created_at
        OR (newer.created_at = e.created_at AND newer.id > e.id));

CREATE UNIQUE INDEX IF NOT EXISTS ux_embeddings_drawer
  ON nexaas_memory.embeddings (drawer_id);
