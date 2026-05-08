/**
 * `nexaas doctor` — runtime diagnostics.
 *
 * Subcommand router for read-only operational health checks. Today:
 *
 *   doctor locks      Concurrency-group lock contention (#98 / #95)
 *
 * Future subcommands will live here too — keep them read-only and pure
 * observability. Anything that mutates state (clears stuck rows, restarts
 * tasks, etc.) belongs under a separate command surface.
 */

import { runLocks } from "./doctor-locks.js";

const USAGE = `\
Usage: nexaas doctor <subcommand> [options]

Subcommands:
  locks [--since <duration>] [--group <name>] [--limit <n>]
        Concurrency-group lock contention report. Reads lock_acquired
        / lock_released WAL events emitted by skills declaring
        concurrency_groups. See #95 / #96 / #98.

Required env: NEXAAS_WORKSPACE
Optional env: DATABASE_URL
`;

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "locks":
      await runLocks(rest);
      return;
    default:
      console.error(`Unknown doctor subcommand: ${sub}`);
      console.error(USAGE);
      process.exit(1);
  }
}
