/**
 * Contract-surface drift guards (#258). docs/contracts.md documents the
 * framework's public surfaces (WAL ops, env vars, worker routes) and
 * palace/ontology.yaml documents the wing taxonomy. These tests extract
 * the same inventories from the CODE and fail when something exists in
 * code but not in the doc — the mechanism that prevents the next #205
 * (shipped endpoint, documented nowhere).
 *
 * Deliberately one-directional: docs may mention retired/planned entries;
 * code may not grow undocumented ones.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const CONTRACTS = readFileSync(join(ROOT, "docs/contracts.md"), "utf-8");
const ONTOLOGY = readFileSync(join(ROOT, "palace/ontology.yaml"), "utf-8");

/** Recursively collect .ts sources under framework src dirs (skips dist). */
function sources(): string[] {
  const roots = [
    "packages/palace/src", "packages/runtime/src", "packages/cli/src",
    "packages/manifest/src", "packages/integration-sdk/src",
    "mcp/servers/palace/src",
    "mcp/servers/email-outbound/src", "mcp/servers/webstudio/src",
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return files;
}

const CODE = sources().map((f) => readFileSync(f, "utf-8")).join("\n");

describe("docs/contracts.md — WAL op registry covers the code", () => {
  const opsInCode = [...new Set(
    [...CODE.matchAll(/op: "([a-z_0-9]+)"/g)].map((m) => m[1]!),
  )].sort();

  it("finds a plausible number of ops (sanity)", () => {
    expect(opsInCode.length).toBeGreaterThan(50);
  });

  for (const op of [...new Set(
    [...CODE.matchAll(/op: "([a-z_0-9]+)"/g)].map((m) => m[1]!),
  )].sort()) {
    it(`documents WAL op \`${op}\``, () => {
      expect(
        CONTRACTS.includes(`\`${op}\``),
        `WAL op '${op}' is written by code but missing from docs/contracts.md §1`,
      ).toBe(true);
    });
  }
});

describe("docs/contracts.md — env vars cover the code", () => {
  const vars = [...new Set(
    [...CODE.matchAll(/process\.env\.([A-Z_0-9]{3,})/g)].map((m) => m[1]!),
  )].sort();

  for (const v of vars) {
    it(`documents env var \`${v}\``, () => {
      expect(
        CONTRACTS.includes(v),
        `env var '${v}' is read by code but missing from docs/contracts.md §2`,
      ).toBe(true);
    });
  }
});

describe("docs/contracts.md — worker routes cover the code", () => {
  const routes = [...new Set(
    [...CODE.matchAll(/app\.(get|post|put|delete|patch)\("([^"]+)"/g)]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`),
  )].sort();

  it("finds a plausible number of routes (sanity)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
  });

  for (const r of routes) {
    it(`documents route \`${r}\``, () => {
      expect(
        CONTRACTS.includes(r),
        `route '${r}' is served by the worker but missing from docs/contracts.md §3`,
      ).toBe(true);
    });
  }
});

describe("palace/ontology.yaml — wings cover the code", () => {
  const wings = [...new Set(
    [...CODE.matchAll(/wing: "([a-z_]+)"/g)].map((m) => m[1]!),
  )].sort();

  for (const w of wings) {
    it(`registers wing \`${w}\``, () => {
      expect(
        new RegExp(`^  ${w}:`, "m").test(ONTOLOGY),
        `wing '${w}' is written by framework code but missing from palace/ontology.yaml`,
      ).toBe(true);
    });
  }
});
