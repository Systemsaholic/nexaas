#!/usr/bin/env node
/**
 * Regression test for #122 Wave 1 — PA persona profile schema + upsert.
 *
 * Covers the Zod-validation half of Wave 1 §1.2 (pure, no DB needed). The
 * upsertPaThreads + migration apply require a Postgres connection; this
 * script exercises only the deterministic logic.
 *
 * Run: node scripts/test-pa-threads-122.mjs
 */

import { writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PersonaProfileSchema,
  loadPersonaProfile,
  detectPaReplyUser,
  MAX_THREADS_PER_PERSONA,
} from "../packages/runtime/src/schemas/persona-profile.ts";

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.log(`  ✗ ${msg}`); fail++; }
}

const tmpDir = join(tmpdir(), `pa-threads-122-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

function writeProfile(name, body) {
  const path = join(tmpDir, `${name}.yaml`);
  writeFileSync(path, body);
  return path;
}

// ── 1. Schema acceptance ──────────────────────────────────────────
console.log("\n1. Valid profile shapes");
{
  const valid = PersonaProfileSchema.safeParse({
    threads: [
      { id: "hr", display: "👥 HR", domain_aliases: ["hr", "onboarding"] },
      { id: "accounting", display: "💰 Accounting", domain_aliases: [] },
    ],
  });
  assert(valid.success, "two-thread profile parses");
  assert(valid.data?.threads.length === 2, "thread count preserved");

  const noAliases = PersonaProfileSchema.safeParse({
    threads: [{ id: "hr", display: "HR" }],
  });
  assert(noAliases.success, "domain_aliases optional, defaults to []");
  assert(Array.isArray(noAliases.data?.threads[0]?.domain_aliases), "default is array");
}

// ── 2. Schema rejection ───────────────────────────────────────────
console.log("\n2. Invalid profile shapes");
{
  const empty = PersonaProfileSchema.safeParse({ threads: [] });
  assert(!empty.success, "empty threads array rejected");

  const dupe = PersonaProfileSchema.safeParse({
    threads: [
      { id: "hr", display: "First" },
      { id: "hr", display: "Second" },
    ],
  });
  assert(!dupe.success, "duplicate ids rejected");

  const badId = PersonaProfileSchema.safeParse({
    threads: [{ id: "HR-Channel", display: "Bad" }],
  });
  assert(!badId.success, "uppercase id rejected");

  const badId2 = PersonaProfileSchema.safeParse({
    threads: [{ id: "1hr", display: "Bad" }],
  });
  assert(!badId2.success, "id starting with digit rejected");

  const emptyDisplay = PersonaProfileSchema.safeParse({
    threads: [{ id: "hr", display: "" }],
  });
  assert(!emptyDisplay.success, "empty display rejected");

  const overlong = PersonaProfileSchema.safeParse({
    threads: Array.from({ length: MAX_THREADS_PER_PERSONA + 1 }, (_, i) => ({
      id: `t${i}`, display: `T${i}`,
    })),
  });
  assert(!overlong.success, `${MAX_THREADS_PER_PERSONA + 1} threads rejected (max is ${MAX_THREADS_PER_PERSONA})`);
}

// ── 3. YAML loader ────────────────────────────────────────────────
console.log("\n3. loadPersonaProfile()");
{
  const validPath = writeProfile("good", `
display_name: "Test PA"
threads:
  - id: hr
    display: "👥 HR"
    domain_aliases: [hr, recruitment]
  - id: accounting
    display: "💰 Accounting"
`);
  const ok = loadPersonaProfile(validPath);
  assert(ok.ok, "valid profile loads");
  assert(ok.ok && ok.profile.threads[0]?.id === "hr", "first thread id 'hr'");

  const missing = loadPersonaProfile(join(tmpDir, "nonexistent.yaml"));
  assert(!missing.ok, "missing file rejected");
  assert(!missing.ok && missing.error.includes("not found"), "error mentions 'not found'");

  const badYaml = writeProfile("malformed", "threads:\n  - id: hr\n  display: oops");
  const parsed = loadPersonaProfile(badYaml);
  assert(!parsed.ok, "malformed YAML rejected");

  const missingThreads = writeProfile("noThreads", `display_name: "PA without threads"`);
  const noThreads = loadPersonaProfile(missingThreads);
  assert(!noThreads.ok, "profile without threads rejected");

  // Profile with other top-level fields we don't validate
  const withExtras = writeProfile("withExtras", `
voice: friendly
avatar: /img/a.png
system_prompt: |
  You are a helpful PA.
threads:
  - id: ops
    display: "⚙️ Ops"
`);
  const extras = loadPersonaProfile(withExtras);
  assert(extras.ok, "profile with unknown top-level fields still loads (we pluck threads only)");
}

// ── 4. detectPaReplyUser ──────────────────────────────────────────
console.log("\n4. detectPaReplyUser()");
{
  assert(detectPaReplyUser("pa_reply_alice") === "alice", "underscore form parses");
  assert(detectPaReplyUser("pa_reply.alice") === "alice", "dot form parses");
  assert(detectPaReplyUser("pa_reply_user-1") === "user-1", "hyphen in user allowed");
  assert(detectPaReplyUser("pa_reply_") === null, "empty user rejected");
  assert(detectPaReplyUser("pa_notify_alice") === null, "wrong prefix rejected");
  assert(detectPaReplyUser(undefined) === null, "undefined handled");
  assert(detectPaReplyUser("") === null, "empty string handled");
  assert(detectPaReplyUser("pa_reply_ALICE") === null, "uppercase user rejected (slug convention)");
}

rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
