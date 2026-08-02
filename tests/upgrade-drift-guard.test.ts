/**
 * #287 — local-drift guard for `nexaas upgrade`. Pure git tests against a
 * throwaway repo: no DB, no network. The WAL emit and refuse/exit live at
 * the call site; this covers the detection + preservation primitive.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLocalDrift } from "../packages/cli/src/upgrade.js";

const tmp = mkdtempSync(join(tmpdir(), "nexaas-287-"));
const repo = join(tmp, "repo");
let releaseSha = "";
let prevBackupDir: string | undefined;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

beforeAll(() => {
  prevBackupDir = process.env.NEXAAS_BACKUP_DIR;
  // Patch bundles land under the test's own dir, not /var/backups.
  process.env.NEXAAS_BACKUP_DIR = join(tmp, "backups");

  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "--allow-empty", "-q", "-m", "base");
  git("commit", "--allow-empty", "-q", "-m", "release: vX");
  releaseSha = git("rev-parse", "HEAD");
});

afterAll(() => {
  process.env.NEXAAS_BACKUP_DIR = prevBackupDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkLocalDrift (#287)", () => {
  it("clean HEAD at the release: no drift", () => {
    expect(checkLocalDrift(repo, releaseSha)).toEqual({
      drifted: false, localCommits: [], patchPath: null,
    });
  });

  it("HEAD behind a newer target: still no drift (normal upgrade)", () => {
    // Simulate the target being AHEAD of HEAD: add the "next release" and
    // point HEAD back at the previous one.
    git("commit", "--allow-empty", "-q", "-m", "release: vX+1");
    const newer = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach", releaseSha);
    expect(checkLocalDrift(repo, newer).drifted).toBe(false);
    git("checkout", "-q", "--detach", newer);
    git("update-ref", "-d", "refs/heads/master");
  });

  it("local hotfix commit on top: drift detected, listed, and preserved", () => {
    const target = git("rev-parse", "HEAD");
    execFileSync("bash", ["-c", `echo hotfix > ${join(repo, "hotfix.txt")}`]);
    git("add", "hotfix.txt");
    git("commit", "-q", "-m", "fix(prod): the 3am hotfix");

    const drift = checkLocalDrift(repo, target);
    expect(drift.drifted).toBe(true);
    expect(drift.localCommits.length).toBe(1);
    expect(drift.localCommits[0]).toContain("fix(prod): the 3am hotfix");
    expect(drift.patchPath).toBeTruthy();
    const bundle = readFileSync(drift.patchPath!, "utf-8");
    expect(bundle).toContain("fix(prod): the 3am hotfix");
    expect(bundle).toContain("+hotfix");
    // Landed under NEXAAS_BACKUP_DIR/drift, not /tmp or /var.
    expect(drift.patchPath!).toContain(join(tmp, "backups", "drift"));
  });
});
