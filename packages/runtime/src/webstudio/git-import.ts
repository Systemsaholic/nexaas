/**
 * Git-clone import path for Web Studio (#147).
 *
 * Companion to the existing wget-scrape path in worker.ts — same
 * endpoint, different `method`. Where scrape downloads a static mirror
 * (good only for marketing sites), git-clone pulls a real repo, detects
 * the framework, installs dependencies, and spawns the project's dev
 * server. This unblocks framework-based sites (Next.js, Vite, CRA,
 * Gatsby) where the scrape snapshot is unusable.
 *
 * The dev server takes over the WebStudio preview port (3002) — the
 * scrape path's static `serve` and the git path's dev server are
 * mutually exclusive per workspace. The caller `fuser -k`s the port
 * before invoking either, so the import always wins over a stale
 * preview.
 */

import { spawn } from "child_process";
import {
  chmodSync, existsSync, mkdirSync, openSync, readdirSync, statSync, writeFileSync,
} from "fs";
import { join } from "path";
import { promisify } from "util";
import { exec as execCallback } from "child_process";

const execAsync = promisify(execCallback);

import { detectFramework, type Framework } from "./framework-detect.js";

export interface GitImportInput {
  url: string;
  branch?: string;            // default 'main'
  deployKey?: string;         // ed25519 private key body
  auth?: "deploy_key" | "https_token";  // honored only when deployKey is present
}

export interface GitImportResult {
  previewUrl: string;
  framework: Framework;
  packageManager: "npm" | "pnpm" | "yarn";
  devServerPid: number | null;
  repoRoot: string;
  branch: string;
  commitSha: string;
}

export interface GitImportPaths {
  // ${NEXAAS_ROOT}/web-studio/<workspace>/repo
  repoRoot: string;
  // ${NEXAAS_ROOT}/web-studio/<workspace>/dev-server.log
  logFile: string;
  // ${NEXAAS_ROOT}/.ssh/<workspace>_deploy_key
  deployKeyPath: string;
}

const MAX_REPO_BYTES = 500 * 1024 * 1024;        // 500MB
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;    // 5 minutes
const PREVIEW_PORT = 3002;

export function gitImportPaths(nexaasRoot: string, workspace: string): GitImportPaths {
  return {
    repoRoot: join(nexaasRoot, "web-studio", workspace, "repo"),
    logFile: join(nexaasRoot, "web-studio", workspace, "dev-server.log"),
    deployKeyPath: join(nexaasRoot, ".ssh", `${workspace}_deploy_key`),
  };
}

export async function runGitImport(
  input: GitImportInput,
  paths: GitImportPaths,
): Promise<GitImportResult> {
  if (!input.url) throw new Error("git import: url required");
  const branch = input.branch ?? "main";

  // 1. Wipe any prior clone — re-importing the same workspace should
  //    yield a fresh checkout. Resist the urge to git-fetch + reset,
  //    since the user may have switched repos entirely.
  if (existsSync(paths.repoRoot)) {
    await execAsync(`rm -rf ${shellEscape(paths.repoRoot)}`);
  }
  mkdirSync(paths.repoRoot, { recursive: true });

  // 2. If a deploy key was supplied, write it (0600) and arrange for
  //    git to use it via GIT_SSH_COMMAND. The ssh `-o IdentitiesOnly=yes`
  //    bit prevents ssh-agent from offering some other key first and
  //    getting the connection rate-limited.
  let gitEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  if (input.deployKey) {
    mkdirSync(join(paths.deployKeyPath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(paths.deployKeyPath, ensureTrailingNewline(input.deployKey), { mode: 0o600 });
    chmodSync(paths.deployKeyPath, 0o600);
    gitEnv.GIT_SSH_COMMAND = `ssh -i ${shellEscape(paths.deployKeyPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  }

  // 3. Clone.
  try {
    await execAsync(
      `git clone --depth=1 --branch=${shellEscape(branch)} ${shellEscape(input.url)} ${shellEscape(paths.repoRoot)}`,
      { env: gitEnv, timeout: 120_000 },
    );
  } catch (err) {
    throw new Error(`git clone failed: ${(err as Error).message}`);
  }

  // 4. Enforce 500MB cap post-clone. A pathological repo could blow the
  //    disk before we noticed; this just catches the obvious cases
  //    (LFS without quotas, accidentally-vendored node_modules).
  const sizeBytes = directorySizeBytes(paths.repoRoot);
  if (sizeBytes > MAX_REPO_BYTES) {
    await execAsync(`rm -rf ${shellEscape(paths.repoRoot)}`);
    throw new Error(`repo exceeds ${MAX_REPO_BYTES} byte cap (got ${sizeBytes})`);
  }

  // 5. Capture the commit sha while .git is still there. Some projects
  //    have a `prepare` script that mucks with .git so do this before
  //    `npm install`.
  let commitSha = "";
  try {
    const { stdout } = await execAsync(`git -C ${shellEscape(paths.repoRoot)} rev-parse HEAD`);
    commitSha = stdout.trim();
  } catch { /* non-fatal */ }

  // 6. Framework detect → choose install command.
  const detection = detectFramework(paths.repoRoot);

  // 7. Install deps. `static` framework still gets an install attempted
  //    if there's a package.json — projects without one skip cleanly.
  const pkgJsonExists = existsSync(join(paths.repoRoot, "package.json"));
  if (pkgJsonExists) {
    const installCmd = installCommand(detection.packageManager, detection.hasLockfile);
    try {
      await execAsync(installCmd, {
        cwd: paths.repoRoot,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        // Some installs need MUCH more than the default 1MB stdio buffer.
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(`dependency install failed: ${(err as Error).message}`);
    }
  }

  // 8. Free the preview port from any prior tenant (scrape's `serve`,
  //    a previous dev server, etc.). Best effort — `fuser` returns
  //    non-zero when nothing is listening, which is fine.
  await execAsync(`fuser -k ${PREVIEW_PORT}/tcp 2>/dev/null || true`).catch(() => { /* ignore */ });

  // 9. Spawn the dev server (if we have one) or fall back to static-serve.
  let devServerPid: number | null = null;
  if (detection.devCommand) {
    devServerPid = await spawnDevServer(detection.devCommand, paths.repoRoot, paths.logFile);
  } else {
    // No detected framework — serve the working copy with `npx serve`
    // so the preview still works for static-only repos.
    devServerPid = await spawnStaticServe(paths.repoRoot, paths.logFile);
  }

  return {
    previewUrl: `http://localhost:${PREVIEW_PORT}`,
    framework: detection.framework,
    packageManager: detection.packageManager,
    devServerPid,
    repoRoot: paths.repoRoot,
    branch,
    commitSha,
  };
}

function installCommand(pm: "npm" | "pnpm" | "yarn", hasLockfile: boolean): string {
  if (pm === "pnpm") return hasLockfile ? "pnpm install --frozen-lockfile" : "pnpm install";
  if (pm === "yarn") return hasLockfile ? "yarn install --frozen-lockfile" : "yarn install";
  return hasLockfile ? "npm ci" : "npm install";
}

async function spawnDevServer(
  cmd: { command: string; args: string[] },
  cwd: string,
  logFile: string,
): Promise<number | null> {
  const out = openSync(logFile, "a");
  const child = spawn(cmd.command, cmd.args, {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    // PORT is the universal env contract for Node-based dev servers
    // (Next, CRA, Vite all honor it; Gatsby has its own flag we set
    // explicitly in framework-detect).
    env: { ...process.env, PORT: String(PREVIEW_PORT) },
  });
  child.unref();
  return child.pid ?? null;
}

async function spawnStaticServe(cwd: string, logFile: string): Promise<number | null> {
  const out = openSync(logFile, "a");
  const child = spawn("npx", ["-y", "serve", "-l", String(PREVIEW_PORT), "-s", cwd], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
  });
  child.unref();
  return child.pid ?? null;
}

function directorySizeBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(p);
        } else if (entry.isFile()) {
          total += statSync(p).size;
        }
      } catch { /* skip unstatable entries */ }
    }
  }
  return total;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}

function shellEscape(s: string): string {
  // Single-quote wrap; close-and-escape any embedded single quotes.
  return `'${s.replace(/'/g, "'\\''")}'`;
}
