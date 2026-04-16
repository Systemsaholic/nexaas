/**
 * nexaas verify-wal — verify WAL chain integrity.
 *
 * Usage:
 *   nexaas verify-wal                  Incremental (since last verification)
 *   nexaas verify-wal --full           Full chain from genesis
 *   nexaas verify-wal --from-id 100    From a specific WAL row ID
 */

import { verifyWalChain } from "@nexaas/palace/wal";
import { createPool } from "@nexaas/palace/db";

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

  console.log(`\n  Verifying WAL for workspace: ${workspace}`);
  console.log(`  Mode: ${fullMode ? "full chain" : fromId ? `from id ${fromId}` : "incremental"}\n`);

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
