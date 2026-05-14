#!/usr/bin/env node
/**
 * Regression test for #159 — symlink hardening in the Web Studio MCP
 * server's safePath() validator.
 *
 * Constructs a temporary repo root with various symlink shapes and
 * verifies that safePath() rejects the dangerous ones and accepts the
 * benign ones.
 *
 * Run:
 *   node --import tsx scripts/test-webstudio-safe-path.mjs
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSafePath } from "../mcp/servers/webstudio/src/safe-path.ts";

const root = mkdtempSync(join(tmpdir(), "webstudio-safepath-"));
const externalTarget = join(tmpdir(), `safepath-external-${Date.now()}.txt`);
writeFileSync(externalTarget, "secret\n");

mkdirSync(join(root, "app"));
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "app", "page.tsx"), "x\n");
writeFileSync(join(root, ".git", "config"), "[core]\n");

// Symlink fixtures
symlinkSync(externalTarget, join(root, "external_file"));            // file → outside ROOT
symlinkSync(tmpdir(), join(root, "external_dir"));                   // dir  → outside ROOT
symlinkSync(".git", join(root, "git_alias"));                        // dir-symlink → forbidden inside ROOT
symlinkSync("app", join(root, "app_alias"));                         // dir-symlink → legit inside ROOT
symlinkSync("app/page.tsx", join(root, "page_alias"));               // file-symlink → legit inside ROOT

const safePath = createSafePath(root);

let pass = 0;
let fail = 0;
function expectThrows(label, fn, matcher) {
  try {
    fn();
    console.log(`  ✗ ${label} — expected to throw, but didn't`);
    fail++;
  } catch (err) {
    if (matcher.test(err.message)) {
      console.log(`  ✓ ${label}`);
      pass++;
    } else {
      console.log(`  ✗ ${label} — threw but message mismatch: ${err.message}`);
      fail++;
    }
  }
}
function expectOk(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${label} — unexpected throw: ${err.message}`);
    fail++;
  }
}

console.log("\nLexical guards (existing behavior, no regression)");
expectThrows("absolute path rejected", () => safePath("/etc/passwd"), /relative to repo root/);
expectThrows("../ traversal rejected", () => safePath("../escape.txt"), /escapes repo root/);
expectThrows("nested ../ traversal rejected", () => safePath("app/../../escape.txt"), /escapes repo root/);
expectThrows("empty string rejected", () => safePath(""), /non-empty/);

console.log("\nSymlink-escape guards (#159)");
expectThrows(
  "symlink file → outside ROOT rejected",
  () => safePath("external_file"),
  /resolves outside repo root via symlink/,
);
expectThrows(
  "symlink dir → outside ROOT (traversed) rejected",
  () => safePath("external_dir/child.txt"),
  /resolves outside repo root via symlink/,
);

console.log("\nSymlink-to-forbidden-dir guards (#159)");
expectThrows(
  "symlink → .git rejected as forbidden",
  () => safePath("git_alias"),
  /\.git\/' are forbidden/,
);
expectThrows(
  "writes via symlink → .git/config rejected as forbidden",
  () => safePath("git_alias/config"),
  /\.git\/' are forbidden/,
);

console.log("\nLegit paths still work");
expectOk("real file in real dir", () => safePath("app/page.tsx"));
expectOk("symlink dir → real intra-repo dir", () => safePath("app_alias/page.tsx"));
expectOk("symlink file → real intra-repo file", () => safePath("page_alias"));
expectOk("new file in existing dir (write_file create)", () => safePath("app/new-component.tsx"));
expectOk("new file at root (write_file create)", () => safePath("README.md"));

console.log("\nDirect forbidden-dir guards (pre-existing behavior, no regression)");
expectThrows("writes to .git/ rejected", () => safePath(".git/config"), /\.git\/' are forbidden/);
expectThrows("writes to node_modules/ rejected", () => safePath("node_modules/foo"), /node_modules\/' are forbidden/);

rmSync(root, { recursive: true, force: true });
rmSync(externalTarget, { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
