/**
 * Phantom-dependency drift guard (#259). Every external module a workspace
 * package imports must be declared in that package's own package.json —
 * resolution via hoisting from a sibling's deps works until an npm
 * dedupe/nested-install change silently breaks it on a production VPS
 * (the CLI shipped that way: pg/bullmq/ioredis imported, never declared).
 *
 * Same one-directional shape as the #258 contract guards: extra declared
 * deps are fine; undeclared imports fail CI.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const BUILTINS = new Set(builtinModules);

/** Packages with importable src. Content-only packages have nothing to scan. */
const PACKAGES = [
  "packages/palace", "packages/runtime", "packages/cli",
  "packages/manifest", "packages/integration-sdk",
  "mcp/servers/palace", "mcp/servers/email-outbound",
].filter((p) => existsSync(join(ROOT, p, "src")));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Root package name of an import specifier ("@scope/pkg/sub" → "@scope/pkg"). */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

for (const pkgDir of PACKAGES) {
  describe(`${pkgDir} — imports are declared`, () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf-8"));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const imports = new Set<string>();
    for (const file of tsFiles(join(ROOT, pkgDir, "src"))) {
      const code = readFileSync(file, "utf-8");
      const patterns = [
        /^\s*(?:import|export)\s[^"'\n]*from\s+"([^"\n]+)"/gm, // static import/re-export
        /import\s*\(\s*"([^"\n]+)"\s*\)/g,                     // dynamic import()
        /^\s*import\s+"([^"\n]+)"/gm,                          // side-effect import
      ];
      for (const pattern of patterns) {
        for (const m of code.matchAll(pattern)) {
          const name = packageOf(m[1]!);
          if (name && !BUILTINS.has(name)) imports.add(name);
        }
      }
    }

    for (const name of [...imports].sort()) {
      it(`declares \`${name}\``, () => {
        expect(
          declared.has(name),
          `${pkg.name} imports '${name}' but doesn't declare it — hoisting luck, not a dependency`,
        ).toBe(true);
      });
    }
  });
}
