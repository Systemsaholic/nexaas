#!/usr/bin/env node
/**
 * Nexaas CLI — framework tooling.
 *
 * Commands:
 *   nexaas init --workspace <id>     Set up Nexaas on a fresh or existing VPS
 *   nexaas status                    Check Nexaas runtime health
 *   nexaas verify-wal                Verify WAL chain integrity
 *   nexaas validate-skill <path>     Validate a skill manifest
 *   nexaas library <subcommand>      Manage the cross-workspace skill library
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
  case "onboard":
    import("./onboard.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "register-skill":
    import("./register-skill.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "trigger-skill":
    import("./trigger-skill.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "config":
    import("./config.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "health":
    import("./health.js").then((m) => m.run());
    break;
  case "migrate-flow":
    import("./migrate-flow.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "seed-palace":
    import("./seed-palace.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "library":
    import("./library.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "propagate":
    import("./propagate.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "alerts":
    import("./alerts.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "dry-run":
    import("./dry-run.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "backup":
    import("./backup.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "upgrade":
    import("./upgrade.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "create-mcp":
    import("./create-mcp.js").then((m) => m.run(process.argv.slice(3)));
    break;
  case "gdpr":
    import("./gdpr.js").then((m) => m.run(process.argv.slice(3)));
    break;
  default:
    console.log(`
Nexaas CLI — framework for context-aware AI execution

Commands:
  init --workspace <id>                 Set up Nexaas on this VPS
  onboard --workspace <path> --id <id>  Discover and register a workspace
  register-skill <path-to-skill.yaml>  Register a skill with the scheduler
  library list|contribute|install|diff|promote  Skill library management
  propagate check|push|accept|reject   Skill update propagation
  alerts [test|config]                 View and manage notifications
  dry-run <path> [--live]              Validate and test a skill locally
  backup [list|test|schedule]          Database backup and restore
  upgrade                              Pull latest framework + apply migrations
  create-mcp <name>                    Scaffold a new MCP server
  gdpr export|delete|redact|subjects   PII management (GDPR compliance)
  status                                Check runtime health
  verify-wal [--full]                   Verify WAL chain integrity

Usage:
  nexaas <command> [options]
`);
}
