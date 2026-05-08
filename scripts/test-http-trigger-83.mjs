#!/usr/bin/env node
/**
 * Regression test for #83 — `/api/skills/trigger` HTTP endpoint helpers.
 *
 * Exercises the pure handler logic without an HTTP server: input
 * validation, path-traversal protection, manifest resolution, the
 * end-to-end trigger orchestrator with stubbed enqueue + audit deps.
 *
 * Run from repo root: `node --import tsx scripts/test-http-trigger-83.mjs`
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateTriggerInput,
  resolveSkillManifestPath,
  loadSkillManifest,
  executeTrigger,
} from "../packages/runtime/src/api/skills-trigger.ts";

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

// ─────────────────────────────────────────────────────────────────────
// 1. validateTriggerInput
// ─────────────────────────────────────────────────────────────────────
{
  const r = validateTriggerInput(null);
  assert("error" in r && r.status === 400, "null body → 400");
}
{
  const r = validateTriggerInput({});
  assert("error" in r && r.status === 400 && /skillId/.test(r.error), "missing skillId → 400 with name");
}
{
  const r = validateTriggerInput({ skillId: "" });
  assert("error" in r && r.status === 400, "empty skillId → 400");
}
{
  const r = validateTriggerInput({ skillId: "marketing/email-broadcast" });
  assert(!("error" in r) && r.skillId === "marketing/email-broadcast", "valid minimal → ok");
}
{
  const r = validateTriggerInput({ skillId: "x/y", actor: 42 });
  assert("error" in r && r.status === 400 && /actor/.test(r.error), "non-string actor → 400");
}
{
  const r = validateTriggerInput({ skillId: "x/y", payload: "not an object" });
  assert("error" in r && r.status === 400 && /payload/.test(r.error), "non-object payload → 400");
}
{
  const r = validateTriggerInput({ skillId: "x/y", payload: ["array", "not", "object"] });
  assert("error" in r && r.status === 400, "array payload → 400");
}
{
  const r = validateTriggerInput({ skillId: "x/y", workspace: "phoenix-voyages", actor: "dashboard:user@example.com", payload: { id: 1 }, idempotencyKey: "abc" });
  assert(!("error" in r) && r.workspace === "phoenix-voyages" && r.idempotencyKey === "abc", "full valid input → preserved");
}

// ─────────────────────────────────────────────────────────────────────
// 2. resolveSkillManifestPath — path traversal protection
// ─────────────────────────────────────────────────────────────────────
{
  const root = "/opt/test-workspace";
  const ok = resolveSkillManifestPath("marketing/email-broadcast", root);
  assert(ok === "/opt/test-workspace/nexaas-skills/marketing/email-broadcast/skill.yaml",
    "well-formed skillId resolves correctly");
}
{
  const root = "/opt/test-workspace";
  assert(resolveSkillManifestPath("../../../etc/passwd", root) === null, "../ traversal → null");
  assert(resolveSkillManifestPath("/abs/path", root) === null, "absolute path → null");
  assert(resolveSkillManifestPath("a/../b", root) === null, "embedded .. → null");
  assert(resolveSkillManifestPath("a\0b", root) === null, "null byte → null");
  assert(resolveSkillManifestPath("a$b", root) === null, "shell-meta char → null");
  assert(resolveSkillManifestPath("a..b", root) === null, "embedded .. (no slash) → null");
  assert(resolveSkillManifestPath("a..b/c", root) === null, "embedded .. with slash → null");
  assert(resolveSkillManifestPath("a b/c", root) === null, "space → null");
}
{
  const root = "/opt/test-workspace";
  assert(resolveSkillManifestPath("a", root) === "/opt/test-workspace/nexaas-skills/a/skill.yaml",
    "single segment ok");
  assert(resolveSkillManifestPath("a/b/c", root) === "/opt/test-workspace/nexaas-skills/a/b/c/skill.yaml",
    "three segments ok");
  assert(resolveSkillManifestPath("under_score-and-dash", root)?.endsWith("/under_score-and-dash/skill.yaml"),
    "underscore + dash ok");
}

// ─────────────────────────────────────────────────────────────────────
// 3. loadSkillManifest
// ─────────────────────────────────────────────────────────────────────
{
  const tmp = mkdtempSync(join(tmpdir(), "trigger-test-"));
  try {
    const goodPath = join(tmp, "good.yaml");
    writeFileSync(goodPath, `id: marketing/test\nversion: "1.0.0"\nexecution:\n  type: ai-skill\n`);
    const m = loadSkillManifest(goodPath);
    assert(m?.id === "marketing/test", "valid manifest loaded");
    assert(m?.execution?.type === "ai-skill", "execution.type preserved");

    const missingPath = join(tmp, "missing.yaml");
    assert(loadSkillManifest(missingPath) === null, "missing file → null");

    const badPath = join(tmp, "bad.yaml");
    writeFileSync(badPath, "this is not yaml: : :");
    assert(loadSkillManifest(badPath) === null, "malformed YAML → null");

    const incompletePath = join(tmp, "incomplete.yaml");
    writeFileSync(incompletePath, "description: only this\n");   // no id, no version
    assert(loadSkillManifest(incompletePath) === null, "missing id/version → null");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. executeTrigger end-to-end with stubbed deps
// ─────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "trigger-e2e-"));
try {
  const skillsRoot = join(tmp, "nexaas-skills");
  mkdirSync(join(skillsRoot, "marketing", "email-broadcast"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "marketing", "email-broadcast", "skill.yaml"),
    `id: marketing/email-broadcast\nversion: "1.0.0"\nexecution:\n  type: ai-skill\n`,
  );
  mkdirSync(join(skillsRoot, "ops", "shell-thing"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "ops", "shell-thing", "skill.yaml"),
    `id: ops/shell-thing\nversion: "0.5.0"\nexecution:\n  type: shell\n`,
  );
  // A manifest where id != path (misconfigured).
  mkdirSync(join(skillsRoot, "broken", "wrong-id"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "broken", "wrong-id", "skill.yaml"),
    `id: actually/different\nversion: "1.0.0"\n`,
  );

  let enqueueCalls = [];
  let auditCalls = [];
  const deps = {
    workspaceRoot: tmp,
    defaultWorkspace: "phoenix-voyages",
    enqueue: async (queueName, jobName, data, opts) => {
      enqueueCalls.push({ queueName, jobName, data, opts });
      return { id: `job-${enqueueCalls.length}` };
    },
    audit: async (entry) => { auditCalls.push(entry); },
  };

  // 4a. Happy path — AI skill.
  {
    const out = await executeTrigger(
      { skillId: "marketing/email-broadcast", payload: { broadcast_id: "b-123" }, actor: "dashboard:al@nexmatic.ca" },
      deps,
    );
    assert(out.status === 202, "AI skill happy path → 202");
    assert(out.body.ok === true, "ok=true");
    assert(typeof out.body.data.runId === "string" && out.body.data.runId.length === 36, "runId is a UUID");
    assert(out.body.data.queueJobId === "job-1", "queueJobId returned");
    assert(enqueueCalls.length === 1, "1 enqueue call");
    assert(enqueueCalls[0].queueName === "nexaas-skills-phoenix-voyages", "queue name uses default workspace");
    assert(enqueueCalls[0].data.skillId === "marketing/email-broadcast", "data has skillId");
    assert(enqueueCalls[0].data.skillVersion === "1.0.0", "data has skillVersion");
    assert(enqueueCalls[0].data.stepId === "ai-exec", "ai-skill → ai-exec stepId");
    assert(enqueueCalls[0].data.triggerType === "manual", "triggerType is manual");
    assert(enqueueCalls[0].data.triggerPayload.broadcast_id === "b-123", "payload forwarded");
    assert(typeof enqueueCalls[0].data.manifestPath === "string", "manifestPath set");
    assert(auditCalls.length === 1, "1 audit call");
    assert(auditCalls[0].op === "skill_trigger_http", "audit op = skill_trigger_http");
    assert(auditCalls[0].actor === "dashboard:al@nexmatic.ca", "audit actor preserved");
  }

  // 4b. Shell skill maps to shell-exec.
  {
    auditCalls = [];
    enqueueCalls = [];
    const out = await executeTrigger(
      { skillId: "ops/shell-thing" },
      deps,
    );
    assert(out.status === 202, "shell skill → 202");
    assert(enqueueCalls[0].data.stepId === "shell-exec", "shell type → shell-exec stepId");
    assert(auditCalls[0].actor === "http-trigger", "default actor = http-trigger");
  }

  // 4c. Missing skill → 404.
  {
    enqueueCalls = [];
    const out = await executeTrigger({ skillId: "nope/missing" }, deps);
    assert(out.status === 404, "missing skill → 404");
    assert(/not found/.test(out.error), "error mentions 'not found'");
    assert(enqueueCalls.length === 0, "no enqueue when not found");
  }

  // 4d. Path traversal → 400.
  {
    enqueueCalls = [];
    const out = await executeTrigger({ skillId: "../../../etc/passwd" }, deps);
    assert(out.status === 400, "traversal attempt → 400");
    assert(enqueueCalls.length === 0, "no enqueue on traversal");
  }

  // 4e. Manifest id mismatch → 400.
  {
    enqueueCalls = [];
    const out = await executeTrigger({ skillId: "broken/wrong-id" }, deps);
    assert(out.status === 400, "manifest id mismatch → 400");
    assert(/mismatch/.test(out.error), "error mentions 'mismatch'");
  }

  // 4f. Idempotency: same key → same jobId encoded.
  {
    enqueueCalls = [];
    await executeTrigger({ skillId: "ops/shell-thing", idempotencyKey: "k1" }, deps);
    await executeTrigger({ skillId: "ops/shell-thing", idempotencyKey: "k1" }, deps);
    assert(enqueueCalls.length === 2, "two enqueue calls fired");
    assert(enqueueCalls[0].opts.jobId === enqueueCalls[1].opts.jobId, "same idempotencyKey → same jobId");
    assert(enqueueCalls[0].opts.jobId === "manual-ops-shell-thing-k1", "jobId encodes idempotencyKey");
  }

  // 4g. No idempotencyKey → unique jobId per call.
  {
    enqueueCalls = [];
    await executeTrigger({ skillId: "ops/shell-thing" }, deps);
    await executeTrigger({ skillId: "ops/shell-thing" }, deps);
    assert(enqueueCalls[0].opts.jobId !== enqueueCalls[1].opts.jobId, "no idempotencyKey → different jobIds");
  }

  // 4h. Workspace override: explicit workspace beats default.
  {
    enqueueCalls = [];
    await executeTrigger({ skillId: "ops/shell-thing", workspace: "other-workspace" }, deps);
    assert(enqueueCalls[0].queueName === "nexaas-skills-other-workspace", "explicit workspace honored");
    assert(enqueueCalls[0].data.workspace === "other-workspace", "data carries the explicit workspace");
  }

  // 4i. No workspace at all → 400.
  {
    enqueueCalls = [];
    const out = await executeTrigger({ skillId: "ops/shell-thing" }, { ...deps, defaultWorkspace: undefined });
    assert(out.status === 400, "no workspace + no default → 400");
    assert(/workspace/.test(out.error), "error mentions workspace");
  }

  // 4j. Audit emit failure doesn't fail the request.
  {
    enqueueCalls = [];
    const flakyDeps = {
      ...deps,
      audit: async () => { throw new Error("DB unreachable"); },
    };
    const out = await executeTrigger({ skillId: "ops/shell-thing" }, flakyDeps);
    assert(out.status === 202, "audit failure → still 202 (best-effort)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
