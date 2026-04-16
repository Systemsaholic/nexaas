/**
 * @nexaas/palace — The memory substrate for the Nexaas framework.
 *
 * Every component in Nexaas attaches to the palace. No component talks
 * to another directly — they all read and write drawers.
 *
 * This package provides:
 * - Palace session management (enter, scoped queries)
 * - Drawer CRUD (write, walk, search)
 * - Closet access (precomputed pointer index)
 * - Waitpoint lifecycle (create, resolve, timeout)
 * - WAL operations (append, verify, sign)
 * - Embedding operations (upsert, search via pgvector)
 */

export { palace, type PalaceSession, type PalaceContext } from "./palace.js";
export { type Drawer, type DrawerId, type DrawerMeta, type RoomPath, type WalkOpts } from "./types.js";
export { type Closet } from "./closets.js";
export { type WaitpointToken, type NotifyConfig } from "./waitpoints.js";
export { type WalEntry } from "./wal.js";
export { createPool } from "./db.js";
