/**
 * @nexaas/palace — The memory substrate for the Nexaas framework.
 */

// Core palace API
export { palace, resolveWaitpoint, type PalaceSession, type PalaceContext } from "./palace.js";

// Types
export { type Drawer, type DrawerId, type DrawerMeta, type RoomPath, type WalkOpts } from "./types.js";

// Closets
export { type Closet } from "./closets.js";

// Waitpoints
export { type WaitpointToken, type NotifyConfig } from "./waitpoints.js";

// WAL
export { appendWal, verifyWalChain, type WalEntry } from "./wal.js";

// Database
export { createPool, getPool, sql, sqlOne, sqlInTransaction } from "./db.js";

// Embeddings
export { upsertEmbedding, searchSimilar, type EmbeddingResult } from "./embeddings.js";

// Signing
export {
  generateOperatorKeyPair,
  loadPrivateKey,
  signPayload,
  verifySignature,
  canonicalSigningPayload,
  signWalEntry,
  getOperatorKeyId,
} from "./signing.js";
