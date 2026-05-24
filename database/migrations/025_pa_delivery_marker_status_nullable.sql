-- Migration 025: pa_delivery_marker.status accepts NULL (issue #206)
-- Date: 2026-05-24
--
-- Follow-through for PR #191 / commit 6ecacee, which changed
-- enqueueDelivery() in packages/runtime/src/pa/delivery.ts to insert
-- status=NULL (instead of 'queued') so workspace consumers using the
-- LEFT-JOIN-NULL eligibility pattern see freshly enqueued markers (see
-- closed #182 for the original silent-drop root cause).
--
-- That code change shipped without the matching schema change:
-- pa_delivery_marker.status was created in migration 021 as
-- `text NOT NULL DEFAULT 'queued'`. Postgres only applies the DEFAULT
-- when the column is omitted from INSERT — an explicit NULL is inserted
-- as-is and trips the NOT NULL constraint (#206).
--
-- Phoenix Voyages observed this on every pa-notify dispatch:
--   error: null value in column "status" of relation "pa_delivery_marker"
--          violates not-null constraint
-- Non-fatal because the upstream notification still delivers, but the
-- delivery-marker row never lands, so per-message tracking is lost.
--
-- Fix:
--   - DROP NOT NULL on status (allow explicit NULL).
--   - DROP DEFAULT on status (omitted column also writes NULL — keeps
--     storage behavior consistent regardless of how callers write).
--
-- The CHECK constraint
--   CHECK (status IN ('queued','sent','failed','dead','skipped'))
-- stays as-is. SQL CHECK passes on NULL by default (NULL IN (...) is
-- NULL, treated as pass), so existing 'queued'/'sent'/etc rows and new
-- explicit-value writes continue to be validated.
--
-- Existing data: rows inserted before PR #191 / commit 6ecacee have
-- status='queued'. They remain valid and continue to be picked up by
-- claimNextDelivery's widened filter (status IS NULL OR status IN
-- ('queued','failed'), per PR #191).

ALTER TABLE nexaas_memory.pa_delivery_marker
  ALTER COLUMN status DROP NOT NULL,
  ALTER COLUMN status DROP DEFAULT;
