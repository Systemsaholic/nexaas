/**
 * @nexaas/manifest unit tests (#256) — the single shared schema/loader
 * that register-skill, dry-run, library, trigger-skill, the trigger API,
 * and the BullMQ worker all consume. The normalize cases mirror
 * scripts/test-manifest-normalize-139.mjs and add the #256 fixes
 * (execution field passthrough, walker filename preference).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findManifestPaths,
  loadManifest,
  normalizeManifest,
  resolveSkillManifestPath,
  validateManifestShape,
} from "../packages/manifest/src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "nexaas-manifest-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("normalizeManifest", () => {
  it("passes native skill.yaml through untouched", () => {
    const raw = {
      id: "ops/report", version: "1.2.0",
      triggers: [{ type: "cron", schedule: "0 9 * * *" }],
      execution: { type: "shell", command: "true", timeout: 5000 },
    };
    expect(normalizeManifest(raw)).toBe(raw as never);
  });

  it("derives id from category/skill on contract.yaml", () => {
    const m = normalizeManifest({ skill: "invoice-chaser", category: "accounting", version: "2.0.0" });
    expect(m.id).toBe("accounting/invoice-chaser");
  });

  it("skips the category prefix when skill already has a slash", () => {
    const m = normalizeManifest({ skill: "ops/nightly", category: "ignored", version: "1" });
    expect(m.id).toBe("ops/nightly");
  });

  it("lifts top-level schedule into a cron trigger", () => {
    const m = normalizeManifest({ skill: "s", category: "c", version: "1", schedule: "*/5 * * * *" });
    expect(m.triggers).toEqual([{ type: "cron", schedule: "*/5 * * * *" }]);
  });

  it("converts timeout_seconds to milliseconds", () => {
    const m = normalizeManifest({
      skill: "s", category: "c", version: "1",
      execution: { type: "shell", command: "true", timeout_seconds: 90 },
    });
    expect(m.execution?.timeout).toBe(90_000);
  });

  it("prefers explicit timeout (ms) over timeout_seconds", () => {
    const m = normalizeManifest({
      skill: "s", category: "c", version: "1",
      execution: { type: "shell", timeout: 1234, timeout_seconds: 90 },
    });
    expect(m.execution?.timeout).toBe(1234);
  });

  it("preserves unknown execution fields on the contract path (pre-#256 dropped them)", () => {
    const m = normalizeManifest({
      skill: "s", category: "c", version: "1",
      execution: { type: "ai-skill", model_tier: "good", primary_output: "digest" },
    });
    expect(m.execution?.model_tier).toBe("good");
    expect(m.execution?.primary_output).toBe("digest");
  });

  it("returns an empty manifest for null/non-object input", () => {
    expect(normalizeManifest(null)).toEqual({});
  });
});

describe("loadManifest", () => {
  it("loads and normalizes a contract.yaml from disk", () => {
    const dir = join(tmp, "load");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "contract.yaml");
    writeFileSync(p, [
      "skill: chaser", "category: accounting", "version: '1.0.0'",
      "schedule: '0 8 * * *'",
      "execution:", "  type: shell", "  command: 'true'", "  timeout_seconds: 60",
    ].join("\n"));
    const m = loadManifest(p);
    expect(m.id).toBe("accounting/chaser");
    expect(m.triggers?.[0]).toEqual({ type: "cron", schedule: "0 8 * * *" });
    expect(m.execution?.timeout).toBe(60_000);
  });

  it("throws on invalid YAML (callers keep their own error handling)", () => {
    const p = join(tmp, "bad.yaml");
    writeFileSync(p, "id: [unclosed");
    expect(() => loadManifest(p)).toThrow();
  });
});

describe("validateManifestShape", () => {
  it("accepts a normalized manifest with extra adopter fields", () => {
    expect(validateManifestShape({
      id: "a/b", version: "1", produces: ["x"], tag_defaults: { y: 1 },
      execution: { type: "ai-skill", model_tier: "good" },
    })).toEqual([]);
  });

  it("reports path-qualified issues", () => {
    const issues = validateManifestShape({ id: "a/b", version: "1", triggers: [{ schedule: "x" }] });
    expect(issues.some((i) => i.includes("triggers.0.type"))).toBe(true);
  });
});

describe("findManifestPaths", () => {
  it("walks category/skill dirs and prefers skill.yaml over contract.yaml", () => {
    const root = join(tmp, "skills-root");
    mkdirSync(join(root, "ops", "both"), { recursive: true });
    mkdirSync(join(root, "ops", "contract-only"), { recursive: true });
    mkdirSync(join(root, "ops", "empty"), { recursive: true });
    writeFileSync(join(root, "ops", "both", "skill.yaml"), "id: ops/both\nversion: '1'\n");
    writeFileSync(join(root, "ops", "both", "contract.yaml"), "skill: both\nversion: '9'\n");
    writeFileSync(join(root, "ops", "contract-only", "contract.yaml"), "skill: contract-only\ncategory: ops\nversion: '1'\n");

    const found = findManifestPaths(root).sort();
    expect(found).toEqual([
      join(root, "ops", "both", "skill.yaml"),
      join(root, "ops", "contract-only", "contract.yaml"),
    ]);
  });

  it("returns [] for a missing root", () => {
    expect(findManifestPaths(join(tmp, "nope"))).toEqual([]);
  });
});

describe("resolveSkillManifestPath", () => {
  it("rejects traversal and resolves under nexaas-skills", () => {
    const wsRoot = join(tmp, "ws");
    mkdirSync(join(wsRoot, "nexaas-skills", "ops", "x"), { recursive: true });
    writeFileSync(join(wsRoot, "nexaas-skills", "ops", "x", "contract.yaml"), "skill: x\nversion: '1'\n");
    expect(resolveSkillManifestPath("../etc/passwd", wsRoot)).toBeNull();
    expect(resolveSkillManifestPath("ops/x", wsRoot))
      .toBe(join(wsRoot, "nexaas-skills", "ops", "x", "contract.yaml"));
  });
});
