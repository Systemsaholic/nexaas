/**
 * Web Studio publish driver (#149).
 *
 * Two methods supported today:
 *
 *   - `zip`        Stream a tar.gz of the working copy back to the
 *                  caller. Replaces the dashboard's in-Nexmatic ZIP
 *                  build so non-Nexmatic adopters get the same flow.
 *
 *   - `git_push`   `git add -A` + `git commit` + `git push` against the
 *                  branch the import (#147) cloned, using the same
 *                  deploy key. No-change → caller signals 204. Empty
 *                  or `wip`/`tmp`/`test` messages are refused.
 *
 * `ftp` is acknowledged by the route but not implemented yet — it'll
 * land as a follow-up once the first customer asks for it. The route
 * returns a 400 for that method.
 *
 * Both implemented methods produce a canonical event payload that the
 * caller writes to events.web-studio.publishes via palace.enter().
 */

import { promisify } from "util";
import { exec as execCallback, spawn } from "child_process";
import { existsSync } from "fs";
import type { Readable } from "stream";

const execAsync = promisify(execCallback);

export type PublishMethod = "zip" | "git_push" | "ftp";

export interface ZipPublishInput {
  method: "zip";
}

export interface GitPushPublishInput {
  method: "git_push";
  commitMessage: string;
}

export interface FtpPublishInput {
  method: "ftp";
  ftp: { host: string; user: string; remoteDir: string };
  // password sourced from env (FTP_PASSWORD_<WORKSPACE_UPPER>), never
  // accepted in the request body.
}

export type PublishInput = ZipPublishInput | GitPushPublishInput | FtpPublishInput;

export interface ZipPublishStream {
  filename: string;
  contentType: "application/gzip";
  stream: Readable;
}

export interface GitPushOutcome {
  changed: true;
  commitSha: string;
  branch: string;
  pushOutput: string;
}

export interface NoChangeOutcome {
  changed: false;
}

// Refuse vacuous commit messages. Catches the obvious "just push it"
// reflex that produces a noisy git history. Operators can override by
// using a meaningful message.
const BAD_MESSAGE_RE = /^\s*(wip|tmp|test|temp|todo|fixme)\b/i;

export function validateCommitMessage(message: unknown): { ok: true; message: string } | { ok: false; error: string } {
  if (typeof message !== "string" || message.trim().length === 0) {
    return { ok: false, error: "commitMessage is required" };
  }
  if (message.trim().length < 3) {
    return { ok: false, error: "commitMessage must be at least 3 characters" };
  }
  if (BAD_MESSAGE_RE.test(message)) {
    return { ok: false, error: "commitMessage looks like a placeholder (wip/tmp/test/etc.) — write a real one" };
  }
  return { ok: true, message: message.trim() };
}

/**
 * Build a tar.gz of `siteRoot` and return a readable stream. Caller is
 * responsible for setting headers and piping into the HTTP response.
 *
 * Implementation note: we shell out to `tar` rather than pulling in
 * `node-tar`. tar is universally present on Linux, its streaming
 * semantics are well-understood, and avoiding a binary dep keeps the
 * runtime image lean.
 */
export function buildSiteArchive(siteRoot: string, hostnameHint?: string): ZipPublishStream {
  if (!existsSync(siteRoot)) {
    throw new Error(`publish: siteRoot does not exist: ${siteRoot}`);
  }
  // `-C <dir> .` makes the archive contents relative — un-tarring on
  // the receiving end recreates the working copy's structure, not the
  // full host path.
  const child = spawn("tar", ["-czf", "-", "-C", siteRoot, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Surface tar errors as stream errors so the HTTP response ends with
  // a clean failure rather than a truncated archive.
  child.on("error", (err) => child.stdout?.destroy(err));
  child.stderr?.on("data", () => { /* tar warnings — ignore */ });

  const filename = `${hostnameHint ?? "site"}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  return {
    filename,
    contentType: "application/gzip",
    stream: child.stdout as Readable,
  };
}

/**
 * Add/commit/push the working copy. Returns `changed: false` when the
 * working tree is clean — the caller should respond 204 No Content
 * with reason: 'no_changes' instead of producing an empty commit.
 *
 * `deployKeyPath` — same path the import (#147) wrote. If the file
 * doesn't exist, we let git fall back to whatever ssh-agent / default
 * keys offer, which works for public repos.
 */
export async function runGitPush(args: {
  repoRoot: string;
  commitMessage: string;
  deployKeyPath?: string;
  authorName?: string;
  authorEmail?: string;
}): Promise<GitPushOutcome | NoChangeOutcome> {
  const { repoRoot, commitMessage, deployKeyPath, authorName, authorEmail } = args;
  if (!existsSync(repoRoot)) {
    throw new Error(`publish: repoRoot does not exist: ${repoRoot}`);
  }
  if (!existsSync(`${repoRoot}/.git`)) {
    throw new Error(`publish: ${repoRoot} is not a git repository (was it cloned via method=git?)`);
  }

  // Build a git env. Use the per-workspace deploy key if it exists —
  // matches the import path. IdentitiesOnly=yes keeps ssh from
  // offering an unrelated key first.
  const gitEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (deployKeyPath && existsSync(deployKeyPath)) {
    gitEnv.GIT_SSH_COMMAND = `ssh -i ${shellEscape(deployKeyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }
  // Author/committer identity. Without this, `git commit` fails on
  // VPSes where there's no system-wide user.name/email configured.
  gitEnv.GIT_AUTHOR_NAME = authorName ?? "Nexaas WebStudio";
  gitEnv.GIT_AUTHOR_EMAIL = authorEmail ?? "webstudio@nexaas.local";
  gitEnv.GIT_COMMITTER_NAME = gitEnv.GIT_AUTHOR_NAME;
  gitEnv.GIT_COMMITTER_EMAIL = gitEnv.GIT_AUTHOR_EMAIL;

  // Detect the current branch — we push the same one the import
  // cloned, no surprises.
  const { stdout: branchOut } = await execAsync(
    `git -C ${shellEscape(repoRoot)} rev-parse --abbrev-ref HEAD`,
    { env: gitEnv },
  );
  const branch = branchOut.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("publish: repo is in a detached HEAD state — checkout a branch first");
  }

  // Stage everything. Honors .gitignore.
  await execAsync(`git -C ${shellEscape(repoRoot)} add -A`, { env: gitEnv });

  // Anything actually staged? `diff --cached --quiet` exits 0 when
  // there are NO staged changes, 1 when there are.
  let hasChanges = false;
  try {
    await execAsync(`git -C ${shellEscape(repoRoot)} diff --cached --quiet`, { env: gitEnv });
    hasChanges = false; // exit 0 → no changes
  } catch (err) {
    const e = err as { code?: number };
    if (e.code === 1) hasChanges = true;
    else throw err; // any other exit code is a real failure
  }
  if (!hasChanges) {
    return { changed: false };
  }

  await execAsync(
    `git -C ${shellEscape(repoRoot)} commit -m ${shellEscape(commitMessage)}`,
    { env: gitEnv, timeout: 30_000 },
  );

  const { stdout: shaOut } = await execAsync(
    `git -C ${shellEscape(repoRoot)} rev-parse HEAD`,
    { env: gitEnv },
  );
  const commitSha = shaOut.trim();

  let pushOutput = "";
  try {
    const result = await execAsync(
      `git -C ${shellEscape(repoRoot)} push origin ${shellEscape(branch)} 2>&1`,
      { env: gitEnv, timeout: 120_000 },
    );
    pushOutput = result.stdout;
  } catch (err) {
    // Treat any non-zero push exit as a failure even though we already
    // have the local commit. The caller surfaces a useful 5xx so the
    // operator can retry. We deliberately don't roll back — the local
    // commit is real work and rerunning the push is the right fix.
    throw new Error(`git push failed: ${(err as Error).message}`);
  }

  return {
    changed: true,
    commitSha,
    branch,
    pushOutput,
  };
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
