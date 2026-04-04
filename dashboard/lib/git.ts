import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

export interface GitLogEntry {
  hash: string;
  hashShort: string;
  author: string;
  date: string;
  message: string;
}

export async function gitLog(path?: string, limit = 20): Promise<GitLogEntry[]> {
  const args = ["log", `--max-count=${limit}`, "--format=%H|%h|%an|%aI|%s"];
  if (path) args.push("--", path);

  const { stdout } = await exec("git", args, { cwd: NEXAAS_ROOT });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, hashShort, author, date, message] = line.split("|");
      return { hash, hashShort, author, date, message };
    });
}

export async function gitDiff(commit: string): Promise<string> {
  const { stdout } = await exec("git", ["show", "--stat", "--patch", commit], {
    cwd: NEXAAS_ROOT,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

export async function gitDiffBetween(from: string, to: string): Promise<string> {
  const { stdout } = await exec("git", ["diff", from, to], {
    cwd: NEXAAS_ROOT,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

export async function gitRevert(commit: string): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-c", "user.name=Nexmatic", "-c", "user.email=ops@nexmatic.com", "revert", "--no-edit", commit],
    { cwd: NEXAAS_ROOT }
  );
  await exec("git", ["push"], { cwd: NEXAAS_ROOT });
  return stdout;
}
