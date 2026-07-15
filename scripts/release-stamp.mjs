#!/usr/bin/env node
/**
 * release-stamp — one command stamps a release version everywhere (#259).
 *
 *   node scripts/release-stamp.mjs 0.4.0
 *
 * Writes, atomically from the operator's point of view:
 *   - VERSION                      (the runtime source of truth — heartbeat,
 *                                   `nexaas version` read this)
 *   - every workspace package.json `version`
 *   - every internal `@nexaas/*` dependency range → ^<version>, so the
 *     workspace graph can never split from the framework version again
 *
 * Then verifies CHANGELOG.md has a `## v<version>` section and prints the
 * remaining ritual (release PR → merge → tag AT the squash commit).
 *
 * Replaces the changesets machinery that was configured in April but never
 * run — package.jsons sat frozen at 0.1.0 while VERSION and git tags moved
 * (the "version schizophrenia" finding). Per-package semver is meaningless
 * here: the framework releases as one unit, so one number stamps all.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/release-stamp.mjs <semver>   e.g. 0.4.0");
  process.exit(1);
}

// Workspace package.json paths from the root manifest's workspaces entries.
// Only trailing-/* globs and literal paths appear there (fs.globSync needs
// node 22; fleet floor is 20).
function expand(pattern) {
  if (!pattern.endsWith("/*")) return [join(repoRoot, pattern, "package.json")];
  const parent = join(repoRoot, pattern.slice(0, -2));
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .map((p) => join(p, "package.json"));
}

const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const pkgPaths = rootPkg.workspaces.flatMap(expand);

let stamped = 0;
for (const pkgPath of pkgPaths) {
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (dep.startsWith("@nexaas/")) pkg[field][dep] = `^${version}`;
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ✓ ${pkgPath.slice(repoRoot.length)} → ${version}`);
  stamped++;
}

rootPkg.version = version;
writeFileSync(join(repoRoot, "package.json"), JSON.stringify(rootPkg, null, 2) + "\n");
console.log(`  ✓ package.json (root) → ${version}`);

writeFileSync(join(repoRoot, "VERSION"), version + "\n");
console.log(`  ✓ VERSION → ${version}`);

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf-8");
const hasSection = new RegExp(`^## v${version.replace(/\./g, "\\.")}\\b`, "m").test(changelog);
if (!hasSection) {
  console.warn(`\n  ⚠ CHANGELOG.md has no "## v${version}" section — write it before the release PR.`);
}

console.log(`
Stamped ${stamped} workspace packages + VERSION.

Next (docs/releases.md):
  1. ${hasSection ? "CHANGELOG section present ✓" : `Add the ## v${version} section to CHANGELOG.md`}
  2. npm install            # refresh package-lock.json with the new versions
  3. Release PR → merge (checks must pass)
  4. git tag v${version} AT THE SQUASH COMMIT on origin/main, push tag
  5. Fast-forward channel branches to the tag
`);
