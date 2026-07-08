/**
 * Unit tests for the trigger-path manifest loader (#246 regression class)
 * and the skill-id path resolver's traversal guard — critical-function
 * coverage from #257. #246: registered contract.yaml skills 404'd on
 * POST /api/skills/trigger because loadSkillManifest only accepted the
 * native `id:` shape; a 5-line test would have caught it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadSkillManifest,
  resolveSkillManifestPath,
} from "../packages/runtime/src/api/skills-trigger.js";

const root = mkdtempSync(join(tmpdir(), "nexaas-manifest-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let fixtureCount = 0;
function fixture(yaml: string): string {
  const path = join(root, `manifest-${fixtureCount++}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

describe("loadSkillManifest — native skill.yaml shape", () => {
  it("parses id/version/execution.type", () => {
    const m = loadSkillManifest(fixture(
      "id: marketing/daily-digest\nversion: 1.2.0\nexecution:\n  type: ai-skill\n",
    ));
    expect(m).toEqual({
      id: "marketing/daily-digest",
      version: "1.2.0",
      execution: { type: "ai-skill" },
    });
  });

  it("coerces a numeric version to string", () => {
    const m = loadSkillManifest(fixture("id: ops/check\nversion: 1.0\n"));
    expect(m?.version).toBe("1");
  });
});

describe("loadSkillManifest — contract.yaml shape (#246)", () => {
  it("derives id as category/skill", () => {
    const m = loadSkillManifest(fixture(
      "skill: daily-digest\ncategory: marketing\nversion: 2.0.0\nexecution:\n  type: ai-skill\n",
    ));
    expect(m?.id).toBe("marketing/daily-digest");
  });

  it("keeps a pre-slashed skill id as-is (category not double-applied)", () => {
    const m = loadSkillManifest(fixture(
      "skill: marketing/daily-digest\ncategory: marketing\nversion: 2.0.0\n",
    ));
    expect(m?.id).toBe("marketing/daily-digest");
  });

  it("uses bare skill as id when category is absent", () => {
    const m = loadSkillManifest(fixture("skill: daily-digest\nversion: 2.0.0\n"));
    expect(m?.id).toBe("daily-digest");
  });

  it("prefers an explicit id over the skill/category derivation", () => {
    const m = loadSkillManifest(fixture(
      "id: ops/explicit\nskill: ignored\ncategory: nope\nversion: 1.0.0\n",
    ));
    expect(m?.id).toBe("ops/explicit");
  });
});

describe("loadSkillManifest — rejection paths", () => {
  it("returns null when neither id nor skill is present", () => {
    expect(loadSkillManifest(fixture("version: 1.0.0\n"))).toBeNull();
  });

  it("returns null when version is missing", () => {
    expect(loadSkillManifest(fixture("id: ops/check\n"))).toBeNull();
  });

  it("returns null for malformed yaml", () => {
    expect(loadSkillManifest(fixture("{{ not: yaml ["))).toBeNull();
  });

  it("returns null for a nonexistent path", () => {
    expect(loadSkillManifest(join(root, "no-such-file.yaml"))).toBeNull();
  });

  it("returns null for a scalar document", () => {
    expect(loadSkillManifest(fixture("just a string\n"))).toBeNull();
  });
});

describe("resolveSkillManifestPath — traversal guard + resolution order", () => {
  const wsRoot = join(root, "ws");
  const skillDir = join(wsRoot, "nexaas-skills", "ops", "both-manifests");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "skill.yaml"), "id: ops/both-manifests\nversion: 1.0.0\n");
  writeFileSync(join(skillDir, "contract.yaml"), "skill: both-manifests\nversion: 1.0.0\n");
  const contractOnly = join(wsRoot, "nexaas-skills", "ops", "contract-only");
  mkdirSync(contractOnly, { recursive: true });
  writeFileSync(join(contractOnly, "contract.yaml"), "skill: contract-only\nversion: 1.0.0\n");

  it("rejects path traversal", () => {
    expect(resolveSkillManifestPath("../../../etc/passwd", wsRoot)).toBeNull();
    expect(resolveSkillManifestPath("ops/../../escape", wsRoot)).toBeNull();
  });

  it("rejects malformed ids", () => {
    expect(resolveSkillManifestPath("/absolute", wsRoot)).toBeNull();
    expect(resolveSkillManifestPath("ops//double", wsRoot)).toBeNull();
    expect(resolveSkillManifestPath("ops/with space", wsRoot)).toBeNull();
  });

  it("prefers skill.yaml when both manifests exist", () => {
    expect(resolveSkillManifestPath("ops/both-manifests", wsRoot))
      .toBe(resolve(skillDir, "skill.yaml"));
  });

  it("falls through to contract.yaml (#246 lookup half)", () => {
    expect(resolveSkillManifestPath("ops/contract-only", wsRoot))
      .toBe(resolve(contractOnly, "contract.yaml"));
  });

  it("returns the conventional skill.yaml path when neither exists (404 messaging)", () => {
    expect(resolveSkillManifestPath("ops/ghost", wsRoot))
      .toBe(resolve(wsRoot, "nexaas-skills", "ops", "ghost", "skill.yaml"));
  });
});
