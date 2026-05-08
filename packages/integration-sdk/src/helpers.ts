/**
 * Helpers shared across integrations (#88).
 *
 * Kept deliberately tiny — anything that pulls a dep or has business
 * logic doesn't belong here. These are the cross-cutting utilities every
 * HTTP-shaped integration ends up writing.
 */

/**
 * Race a promise against a timeout. Used by HTTP-shaped integrations to
 * bound vendor calls; the framework already has its own timeouts at the
 * MCP/skill layer, but per-call bounds keep tail latency predictable.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Normalize `T | T[]` to `T[]`. Common when a capability accepts either shape. */
export function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}
