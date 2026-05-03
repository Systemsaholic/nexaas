/**
 * Capability types for the email-outbound MCP shell.
 *
 * The canonical definitions now live in `@nexaas/integration-sdk` (#88
 * Phase 2). This file re-exports them so the shell's existing imports
 * (`./types.js`) keep working — Postmark and SendGrid still live in
 * `./providers/` and import from here. They'll switch to importing
 * directly from `@nexaas/integration-sdk` when each gets extracted in a
 * follow-up PR.
 */

export type {
  EmailProvider,
  SendInput,
  SendOutput,
  TrackOutput,
} from "@nexaas/integration-sdk";
