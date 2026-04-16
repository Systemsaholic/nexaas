#!/usr/bin/env node
/**
 * Nexaas CLI — framework tooling.
 *
 * Commands:
 *   nexaas init --workspace <id>     Set up Nexaas on a fresh or existing VPS
 *   nexaas status                    Check Nexaas runtime health
 *   nexaas verify-wal                Verify WAL chain integrity
 *   nexaas validate-skill <path>     Validate a skill manifest
 */

const command = process.argv[2];

switch (command) {
  case "init":
    import("./init.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "status":
    import("./status.js").then((m) => m.run());
    break;
  case "verify-wal":
    import("./verify-wal.js").then((m) => m.run(process.argv.slice(3)));
    break;
  default:
    console.log(`
Nexaas CLI — framework for context-aware AI execution

Commands:
  init --workspace <id>     Set up Nexaas on this VPS
  status                    Check runtime health
  verify-wal [--full]       Verify WAL chain integrity

Usage:
  node packages/cli/src/index.js <command> [options]
`);
}
