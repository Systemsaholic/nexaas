#!/usr/bin/env node
/**
 * Regression test for #172 — phantom-skill guards.
 *
 * Two halves:
 *   - Pure: isEphemeralPath() classifier covers /tmp, /run, /var/tmp,
 *     /dev/shm, $XDG_RUNTIME_DIR; rejects workspace paths.
 *   - Pure: terminal-drawer shape for manifest_missing.
 *   - Integration: register-skill's registerOneSkill() refuses an
 *     ephemeral path and accepts the same manifest from a workspace path,
 *     and respects --allow-ephemeral via allowEphemeral on the context.
 *
 * Run: node --import tsx scripts/test-manifest-missing-172.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import {
  isEphemeralPath,
  buildTerminalDrawerPayload,
} from "../packages/runtime/src/skill-terminal.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

// ── 1. isEphemeralPath classifier ─────────────────────────────────
console.log("\n1. isEphemeralPath() classifier");
{
  assert(isEphemeralPath("/tmp/skill.yaml") === true, "/tmp/ → ephemeral");
  assert(isEphemeralPath("/tmp/foo/bar/skill.yaml") === true, "nested under /tmp → ephemeral");
  assert(isEphemeralPath("/var/tmp/skill.yaml") === true, "/var/tmp → ephemeral");
  assert(isEphemeralPath("/run/user/1000/skill.yaml") === true, "/run/ → ephemeral");
  assert(isEphemeralPath("/dev/shm/skill.yaml") === true, "/dev/shm → ephemeral");

  assert(isEphemeralPath("/home/ubuntu/workspace/nexaas-skills/x/skill.yaml") === false,
    "workspace path → not ephemeral");
  assert(isEphemeralPath("/opt/nexaas/nexaas-skills/x/skill.yaml") === false,
    "/opt/ → not ephemeral");
  assert(isEphemeralPath("/tmpfoo/skill.yaml") === false,
    "/tmpfoo (not /tmp/) → not ephemeral (trailing-slash matters)");
  assert(isEphemeralPath("") === false, "empty string → not ephemeral");

  // $XDG_RUNTIME_DIR — set then verify
  const prev = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "/run/user/1000";
  assert(isEphemeralPath("/run/user/1000/skill.yaml") === true,
    "$XDG_RUNTIME_DIR → ephemeral");
  // Custom XDG dir outside the canonical prefixes
  process.env.XDG_RUNTIME_DIR = "/var/runtime/myuser";
  assert(isEphemeralPath("/var/runtime/myuser/skill.yaml") === true,
    "custom XDG_RUNTIME_DIR → ephemeral");
  if (prev === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = prev;
}

// ── 2. manifest_missing drawer shape ──────────────────────────────
console.log("\n2. manifest_missing drawer carries diagnostic hints");
{
  const payload = buildTerminalDrawerPayload(
    { skill: "marketing/freshness-watchdog", terminal_reason: "manifest_missing" },
    {
      manifest_path: "/tmp/skill-test.yaml",
      was_ephemeral_path: true,
      trigger_type: "cron",
    },
  );
  assert(payload.success === false, "manifest_missing is a failure");
  assert(payload.terminal_reason === "manifest_missing", "terminal_reason set");
  assert(payload.manifest_path === "/tmp/skill-test.yaml", "manifest_path carried");
  assert(payload.was_ephemeral_path === true, "ephemeral hint carried");
  assert(payload.trigger_type === "cron", "trigger_type carried");
}

// ── 3. registerOneSkill refuses ephemeral path without override ───
console.log("\n3. registerOneSkill() refuses ephemeral path");
{
  // Lazy-import so the runtime tsx pipeline doesn't init BullMQ until we need it.
  const { registerOneSkill } = await import("../packages/cli/src/register-skill.ts");

  // Create a manifest at /tmp/ that's otherwise valid.
  const dir = mkdtempSync(join(tmpdir(), "manifest-missing-test-"));
  const manifestPath = join(dir, "skill.yaml");
  writeFileSync(manifestPath, [
    "id: ops/test-ephemeral",
    "version: 1.0.0",
    "triggers:",
    "  - type: cron",
    "    schedule: '0 * * * *'",
    "execution:",
    "  type: shell",
    "  command: echo hi",
  ].join("\n"));

  // No Redis queue is needed — refusal happens before any queue use.
  const fakeQueue = { upsertJobScheduler: async () => {}, getRepeatableJobs: async () => [], removeRepeatableByKey: async () => {} };
  const ctx = { queue: fakeQueue, workspace: "test", workspaceTz: "UTC" };

  const refused = await registerOneSkill(manifestPath, ctx);
  assert(refused.status === "error", "ephemeral path → status=error");
  assert(typeof refused.error === "string" && refused.error.includes("ephemeral"),
    "error message mentions 'ephemeral'");
  assert(typeof refused.error === "string" && refused.error.includes("--allow-ephemeral"),
    "error message hints at the --allow-ephemeral override");

  // With allowEphemeral true the path check is bypassed. The call will
  // hit the fake queue (which accepts anything) and report success.
  const accepted = await registerOneSkill(manifestPath, { ...ctx, allowEphemeral: true });
  assert(accepted.status === "registered" || accepted.status === "no-triggers",
    `--allow-ephemeral bypass works (status=${accepted.status})`);

  // Cleanup
  rmSync(dir, { recursive: true, force: true });
}

// ── 4. Non-ephemeral path is accepted ─────────────────────────────
console.log("\n4. registerOneSkill() accepts workspace path");
{
  const { registerOneSkill } = await import("../packages/cli/src/register-skill.ts");

  // Place the manifest under the user's home dir (definitely not ephemeral).
  const dir = join(homedir(), `.nexaas-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "skill.yaml");
  writeFileSync(manifestPath, [
    "id: ops/test-workspace",
    "version: 1.0.0",
    "triggers:",
    "  - type: cron",
    "    schedule: '*/5 * * * *'",
    "execution:",
    "  type: shell",
    "  command: echo hi",
  ].join("\n"));

  const fakeQueue = { upsertJobScheduler: async () => {}, getRepeatableJobs: async () => [], removeRepeatableByKey: async () => {} };
  const result = await registerOneSkill(manifestPath, { queue: fakeQueue, workspace: "test", workspaceTz: "UTC" });
  assert(result.status !== "error" || !(result.error?.includes("ephemeral")),
    `workspace path accepted (status=${result.status})`);

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
