/**
 * nexaas verify-wal — verify WAL chain integrity.
 *
 * Usage:
 *   nexaas verify-wal                  Recent window (last 10,000 entries)
 *   nexaas verify-wal --full           Full chain from genesis
 *   nexaas verify-wal --from-id 100    From a specific WAL row ID
 *
 * The no-flag default used to claim "incremental" while actually scanning
 * genesis-to-tip (fromId was never computed) — which both lied about its
 * cost and, before the batched verifier landed in @nexaas/palace, exhausted
 * the heap on production-sized WALs (found by the v0.3.1 Phoenix canary).
 * Default is now a true recent window; --full is the explicit audit mode and
 * is memory-safe at any size (batched), just proportionally slow.
 */

import { verifyWalChain } from "@nexaas/palace";
import { createPool, sqlOne } from "@nexaas/palace";

const DEFAULT_WINDOW = 10_000;

export async function run(args: string[]) {
  const workspace = process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("NEXAAS_WORKSPACE is required");
    process.exit(1);
  }

  createPool();

  let fromId: number | undefined;
  const fullMode = args.includes("--full");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from-id" && args[i + 1]) {
      fromId = parseInt(args[i + 1]!, 10);
    }
  }

  let mode = "full chain";
  if (!fullMode) {
    if (fromId === undefined) {
      const anchor = await sqlOne<{ id: number }>(
        `SELECT id FROM nexaas_memory.wal WHERE workspace = $1
          ORDER BY id DESC LIMIT 1 OFFSET ${DEFAULT_WINDOW - 1}`,
        [workspace],
      );
      fromId = anchor?.id; // small WALs: undefined → full chain (cheap anyway)
      mode = fromId ? `recent window (last ${DEFAULT_WINDOW} entries, from id ${fromId})` : "full chain (small WAL)";
    } else {
      mode = `from id ${fromId}`;
    }
  }

  console.log(`\n  Verifying WAL for workspace: ${workspace}`);
  console.log(`  Mode: ${mode}\n`);

  const start = Date.now();
  const result = await verifyWalChain(workspace, fullMode ? undefined : fromId);
  const elapsed = Date.now() - start;

  if (result.valid) {
    console.log(`  ✓ WAL chain verified (${elapsed}ms)`);
    console.log(`  No integrity issues found.\n`);
  } else {
    console.error(`  ✗ WAL chain BROKEN at row ${result.brokenAt}`);
    console.error(`  Error: ${result.error}`);
    console.error(`\n  This is a critical integrity issue. Investigate immediately.\n`);
    process.exit(1);
  }
}
