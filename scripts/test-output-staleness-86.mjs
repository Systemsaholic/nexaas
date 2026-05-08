#!/usr/bin/env node
/**
 * Regression test for #86 Gap 1 — output-cadence staleness watchdog.
 *
 * The parseDuration helper has no DB dependency and is exercised here.
 * The findStaleOutputs / WAL-query path requires DATABASE_URL — runs
 * against a real Nexaas-bootstrapped Postgres, same pattern as
 * test-shutdown-sweep-86.mjs.
 *
 * Run from repo root: `node --import tsx scripts/test-output-staleness-86.mjs`
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sql, appendWal } from "@nexaas/palace";
import {
  parseDuration,
  findStaleOutputs,
} from "../packages/runtime/src/tasks/output-staleness-watchdog.ts";

const WORKSPACE = `staleness-test-${Date.now()}-${process.pid}`;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log(`OK    ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}`); fail++; }
}

// ─────────────────────────────────────────────────────────────────────
// parseDuration — pure, no DB
// ─────────────────────────────────────────────────────────────────────
assert(parseDuration("9d") === 9 * 24 * 60 * 60 * 1000, "9d");
assert(parseDuration("12h") === 12 * 60 * 60 * 1000, "12h");
assert(parseDuration("30m") === 30 * 60 * 1000, "30m");
assert(parseDuration("90s") === 90 * 1000, "90s");
assert(parseDuration("500ms") === 500, "500ms");
assert(parseDuration("1.5h") === 1.5 * 60 * 60 * 1000, "decimal: 1.5h");
assert(parseDuration("9 d") === 9 * 24 * 60 * 60 * 1000, "whitespace tolerated");
assert(parseDuration("9D") === 9 * 24 * 60 * 60 * 1000, "case-insensitive");
assert(parseDuration("") === 0, "empty → 0");
assert(parseDuration("9") === 0, "no unit → 0");
assert(parseDuration("foo") === 0, "garbage → 0");
assert(parseDuration("-5d") === 0, "negative → 0");
assert(parseDuration("0d") === 0, "zero → 0");
assert(parseDuration(null) === 0, "null → 0");

// ─────────────────────────────────────────────────────────────────────
// findStaleOutputs — exercises manifest reading + WAL query
// ─────────────────────────────────────────────────────────────────────
let skillsRoot = null;
try {
  // Build a tiny on-disk manifest tree.
  const tmp = mkdtempSync(join(tmpdir(), "staleness-test-"));
  skillsRoot = join(tmp, "nexaas-skills");
  mkdirSync(join(skillsRoot, "marketing", "fresh-skill"), { recursive: true });
  mkdirSync(join(skillsRoot, "marketing", "stale-skill"), { recursive: true });
  mkdirSync(join(skillsRoot, "ops", "no-staleness"), { recursive: true });
  mkdirSync(join(skillsRoot, "ops", "never-produced"), { recursive: true });

  // Skill 1: produced recently → not stale.
  writeFileSync(
    join(skillsRoot, "marketing", "fresh-skill", "skill.yaml"),
    `id: marketing/fresh-skill\nversion: "1.0.0"\noutputs:\n  - id: weekly_post\n    routing_default: auto_execute\n    staleness_alert:\n      max_silence: 9d\n      channel_role: ops_escalations\n`,
  );

  // Skill 2: produced 14 days ago → stale (max 9d).
  writeFileSync(
    join(skillsRoot, "marketing", "stale-skill", "skill.yaml"),
    `id: marketing/stale-skill\nversion: "1.0.0"\noutputs:\n  - id: weekly_broadcast\n    routing_default: auto_execute\n    staleness_alert:\n      max_silence: 9d\n      channel_role: ops_escalations\n`,
  );

  // Skill 3: declares an output without staleness_alert → ignored.
  writeFileSync(
    join(skillsRoot, "ops", "no-staleness", "skill.yaml"),
    `id: ops/no-staleness\nversion: "1.0.0"\noutputs:\n  - id: silent_output\n    routing_default: auto_execute\n`,
  );

  // Skill 4: declares staleness_alert but has never produced anything → stale.
  writeFileSync(
    join(skillsRoot, "ops", "never-produced", "skill.yaml"),
    `id: ops/never-produced\nversion: "1.0.0"\noutputs:\n  - id: would_be_published\n    routing_default: auto_execute\n    staleness_alert:\n      max_silence: 1d\n      channel_role: ops_escalations\n`,
  );

  const NOW = Date.now();
  // Insert a recent output_produced for fresh-skill.
  await appendWal({
    workspace: WORKSPACE,
    op: "output_produced",
    actor: "skill:marketing/fresh-skill",
    payload: {
      skill_id: "marketing/fresh-skill",
      output_id: "weekly_post",
      output_kind: "social",
      routing: "auto_execute",
    },
  });
  // Insert a 14-day-old output_produced for stale-skill.
  await sql(
    `INSERT INTO nexaas_memory.wal (workspace, op, actor, payload, created_at, prev_hash, hash)
     VALUES ($1, 'output_produced', 'skill:marketing/stale-skill', $2::jsonb,
             now() - interval '14 days', '0', 'test-hash-' || gen_random_uuid())`,
    [WORKSPACE, JSON.stringify({
      skill_id: "marketing/stale-skill",
      output_id: "weekly_broadcast",
      output_kind: "email",
      routing: "auto_execute",
    })],
  );

  const stale = await findStaleOutputs(WORKSPACE, [
    join(skillsRoot, "marketing", "fresh-skill", "skill.yaml"),
    join(skillsRoot, "marketing", "stale-skill", "skill.yaml"),
    join(skillsRoot, "ops", "no-staleness", "skill.yaml"),
    join(skillsRoot, "ops", "never-produced", "skill.yaml"),
  ], NOW);

  // fresh-skill: ~now < 9d → not stale, not in result
  // stale-skill: 14d old > 9d max → stale
  // no-staleness: no config → ignored
  // never-produced: lastAt null → silent forever > 1d max → stale

  assert(stale.length === 2, `2 stale outputs (got ${stale.length})`);

  const ids = new Set(stale.map((s) => `${s.skillId}/${s.outputId}`));
  assert(ids.has("marketing/stale-skill/weekly_broadcast"), "stale-skill flagged");
  assert(ids.has("ops/never-produced/would_be_published"), "never-produced flagged");
  assert(!ids.has("marketing/fresh-skill/weekly_post"), "fresh-skill NOT flagged");
  assert(!ids.has("ops/no-staleness/silent_output"), "no-staleness config → not flagged");

  const staleSkill = stale.find((s) => s.skillId === "marketing/stale-skill");
  assert(staleSkill?.lastProducedIso != null, "stale-skill: lastProducedIso populated");
  assert(staleSkill?.silentForMs > 13 * 24 * 60 * 60 * 1000, "stale-skill: silentForMs > 13 days");
  assert(staleSkill?.channelRole === "ops_escalations", "stale-skill: channelRole from manifest");

  const neverProduced = stale.find((s) => s.skillId === "ops/never-produced");
  assert(neverProduced?.lastProducedIso === null, "never-produced: lastProducedIso null");
  assert(neverProduced?.maxSilenceMs === 24 * 60 * 60 * 1000, "never-produced: max=1d (24h)");
} finally {
  // Cleanup WAL rows.
  await sql(`DELETE FROM nexaas_memory.wal WHERE workspace = $1`, [WORKSPACE]);
  if (skillsRoot) {
    try { rmSync(join(skillsRoot, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
