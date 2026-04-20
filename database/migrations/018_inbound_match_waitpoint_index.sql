-- Partial index for open inbound-match waitpoints (#54).
--
-- matchDrawerAgainstWaitpoints runs a SELECT per inbound drawer scoped
-- to:
--   WHERE workspace = $1
--     AND wing = 'waitpoints' AND hall = 'inbound_match' AND room = 'active'
--     AND dormant_signal IS NOT NULL
--   ORDER BY created_at ASC
--
-- At low waitpoint counts this is trivial, but the events table holds
-- all drawers across all rooms and grows fast. Without a targeted index,
-- this query falls back to scanning (workspace, wing, hall, room) plus
-- a filter on dormant_signal — wasteful once the events table has
-- hundreds of thousands of rows.
--
-- Partial index keyed on (workspace, created_at) with the room-scope
-- predicate folded into the index condition makes this query O(log N)
-- regardless of events-table size. Near-zero cost: the open-waitpoints
-- set is typically ≤ 50 rows per workspace.

CREATE INDEX IF NOT EXISTS ix_waitpoints_inbound_match_active
  ON nexaas_memory.events (workspace, created_at)
  WHERE wing = 'waitpoints'
    AND hall = 'inbound_match'
    AND room = 'active'
    AND dormant_signal IS NOT NULL;
