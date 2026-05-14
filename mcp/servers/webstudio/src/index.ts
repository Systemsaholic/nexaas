/**
 * Nexaas Web Studio MCP Server (#148).
 *
 * Provides the file-tool surface for the PA-driven Web Studio edit loop:
 *
 *   - list_files   walk the working copy (respects .gitignore + .webstudioignore)
 *   - read_file    read a single file (100KB cap, binary-safe)
 *   - write_file   write a single file (path-traversal + binary-write protection)
 *   - grep         pattern search across the project (git grep when available)
 *   - diff         pending uncommitted changes
 *
 * Scoped to a single workspace's working copy via the WEBSTUDIO_REPO_ROOT
 * environment variable. Every path argument from the model is resolved
 * inside that root and rejected if it escapes; the server NEVER touches
 * paths outside the configured root.
 *
 * Transport: stdio. Companion to the import path (#147) and publish
 * path (#149). Replaces the single-file-in-prompt pattern that lives in
 * the original /api/webstudio/edit handler.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSync } from "child_process";
import {
  existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync,
} from "fs";
import { dirname, join, relative, resolve as resolvePath } from "path";
import { createSafePath, FORBIDDEN_DIRS } from "./safe-path.js";

const REPO_ROOT = process.env.WEBSTUDIO_REPO_ROOT;
if (!REPO_ROOT) {
  console.error("[webstudio-mcp] WEBSTUDIO_REPO_ROOT is required");
  process.exit(1);
}
const ROOT = resolvePath(REPO_ROOT);

if (!existsSync(ROOT)) {
  console.error(`[webstudio-mcp] WEBSTUDIO_REPO_ROOT not found: ${ROOT}`);
  process.exit(1);
}

const safePath = createSafePath(ROOT);

const READ_CAP_BYTES = 100 * 1024; // 100KB per the spec
const WRITE_CAP_BYTES = 5 * 1024 * 1024; // 5MB ceiling on individual writes

// Defaults applied when there's no .webstudioignore. Tighter than
// gitignore so the model sees a useful slice of the project even on
// repos with no ignore file.
const DEFAULT_IGNORE = [
  "node_modules/",
  ".git/",
  ".next/",
  "dist/",
  "build/",
  ".nuxt/",
  ".svelte-kit/",
  "*.log",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const server = new McpServer({
  name: "nexaas-webstudio",
  version: "0.1.0",
});

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

function isInGitRepo(): boolean {
  return existsSync(join(ROOT, ".git"));
}

// Cheap binary sniff — null bytes in the first 8KB. Catches images,
// archives, compiled binaries. Good enough for protecting write_file
// from clobbering binary assets with text.
function looksBinary(buf: Buffer): boolean {
  const sample = buf.length > 8192 ? buf.subarray(0, 8192) : buf;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

// Read .webstudioignore (line-based, gitignore-syntax-ish). Returns
// the patterns, or DEFAULT_IGNORE if the file isn't there.
function loadIgnorePatterns(): string[] {
  const file = join(ROOT, ".webstudioignore");
  if (!existsSync(file)) return DEFAULT_IGNORE;
  try {
    return readFileSync(file, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return DEFAULT_IGNORE;
  }
}

// Minimal gitignore-ish matcher. Sufficient for the default skip-list;
// power users can ship a real .gitignore and we'll route through `git
// ls-files` instead.
function matchesIgnore(relPath: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith("/")) {
      const dir = p.slice(0, -1);
      if (relPath === dir || relPath.startsWith(dir + "/")) return true;
    } else if (p.startsWith("*.")) {
      if (relPath.endsWith(p.slice(1))) return true;
    } else if (p.includes("*")) {
      const re = new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      if (re.test(relPath)) return true;
    } else {
      if (relPath === p || relPath.endsWith("/" + p)) return true;
    }
  }
  return false;
}

// Glob → regex. Supports `*` (anything except /), `**` (anything),
// `?` (one char). Anchored at both ends.
function globToRegex(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"; i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*"; i++;
      }
    } else if (c === "?") {
      re += "[^/]"; i++;
    } else if (".+()|^$\\[]{}".includes(c!)) {
      re += "\\" + c; i++;
    } else {
      re += c; i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

// ─── list_files ─────────────────────────────────────────────────────

server.tool(
  "list_files",
  "List files in the Web Studio working copy. Respects .gitignore (when the project is a git repo) " +
  "and .webstudioignore (always). Optionally filtered by a glob pattern like 'app/**/*.tsx' or '**/*.css'. " +
  "Returns relative paths from the repo root. Use this first to discover the layout before reading files.",
  {
    pattern: z.string().optional().describe(
      "Optional glob filter. Supports *, **, ?. Examples: 'app/**/*.tsx', '**/*.css', 'components/Hero.tsx'.",
    ),
    limit: z.number().int().positive().max(2000).optional().describe(
      "Maximum number of paths to return. Default 500.",
    ),
  },
  async (input) => {
    try {
      const limit = input.limit ?? 500;
      let paths: string[];
      if (isInGitRepo()) {
        // `git ls-files` is gitignore-aware. Include modified+untracked so
        // the model sees what the user just created during the session.
        const out = spawnSync(
          "git",
          ["-C", ROOT, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          { maxBuffer: 50 * 1024 * 1024 },
        );
        if (out.status === 0) {
          paths = out.stdout.toString("utf-8").split("\0").filter((p) => p.length > 0);
        } else {
          paths = walkFs();
        }
      } else {
        paths = walkFs();
      }

      // Always apply .webstudioignore on top (it's the project owner's
      // way to narrow visibility further, even inside git).
      const ignore = loadIgnorePatterns();
      let filtered = paths.filter((p) => !matchesIgnore(p, ignore));
      if (input.pattern) {
        const re = globToRegex(input.pattern);
        filtered = filtered.filter((p) => re.test(p));
      }
      const truncated = filtered.length > limit;
      const result = truncated ? filtered.slice(0, limit) : filtered;
      return jsonResult({ ok: true, count: result.length, total: filtered.length, truncated, files: result });
    } catch (err) {
      return jsonResult({ ok: false, error: (err as Error).message });
    }
  },
);

function walkFs(): string[] {
  const out: string[] = [];
  const stack = [ROOT];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(ROOT, abs);
      if (entry.isDirectory()) {
        // Skip forbidden dirs eagerly — saves walking
        // node_modules/.git on every list.
        if (FORBIDDEN_DIRS.includes(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out;
}

// ─── read_file ──────────────────────────────────────────────────────

server.tool(
  "read_file",
  "Read a single file from the working copy. Path is relative to the repo root. " +
  "Capped at 100KB — larger files return the first 100KB with a '[...truncated]' marker. " +
  "Binary files (detected by null-byte sniff) return an error rather than garbled text.",
  {
    path: z.string().min(1).describe("File path relative to the repo root, e.g. 'app/page.tsx'."),
  },
  async (input) => {
    try {
      const abs = safePath(input.path);
      if (!existsSync(abs)) {
        return jsonResult({ ok: false, error: `file not found: '${input.path}'` });
      }
      const stats = statSync(abs);
      if (!stats.isFile()) {
        return jsonResult({ ok: false, error: `not a file: '${input.path}'` });
      }
      const buf = readFileSync(abs);
      if (looksBinary(buf)) {
        return jsonResult({
          ok: false,
          error: `'${input.path}' looks like a binary file (null bytes detected) — read_file is text-only`,
          size_bytes: stats.size,
        });
      }
      const truncated = buf.length > READ_CAP_BYTES;
      const text = truncated
        ? buf.subarray(0, READ_CAP_BYTES).toString("utf-8") + "\n\n[...truncated]"
        : buf.toString("utf-8");
      return jsonResult({
        ok: true,
        path: input.path,
        size_bytes: stats.size,
        truncated,
        content: text,
      });
    } catch (err) {
      return jsonResult({ ok: false, error: (err as Error).message });
    }
  },
);

// ─── write_file ─────────────────────────────────────────────────────

server.tool(
  "write_file",
  "Write a single file in the working copy. Path is relative to the repo root and resolved with " +
  "path-traversal protection — writes to .git/, node_modules/, .next/, dist/, build/ are refused. " +
  "Refuses to overwrite a file with content that would make it look binary (null bytes). Creates " +
  "parent directories as needed. Always read a file before writing it.",
  {
    path: z.string().min(1).describe("File path relative to the repo root."),
    content: z.string().describe("New file content. UTF-8 text only."),
  },
  async (input) => {
    try {
      const abs = safePath(input.path);
      if (input.content.length > WRITE_CAP_BYTES) {
        return jsonResult({ ok: false, error: `content exceeds ${WRITE_CAP_BYTES} byte cap` });
      }
      const buf = Buffer.from(input.content, "utf-8");
      if (looksBinary(buf)) {
        return jsonResult({ ok: false, error: "content contains null bytes — write_file is text-only" });
      }
      mkdirSync(dirname(abs), { recursive: true });
      const existed = existsSync(abs);
      writeFileSync(abs, buf);
      return jsonResult({
        ok: true,
        path: input.path,
        bytes_written: buf.length,
        created: !existed,
      });
    } catch (err) {
      return jsonResult({ ok: false, error: (err as Error).message });
    }
  },
);

// ─── grep ───────────────────────────────────────────────────────────

server.tool(
  "grep",
  "Search the working copy for a pattern. Uses 'git grep' when the project is a git repo " +
  "(gitignore-aware), falls back to a recursive grep with sensible excludes otherwise. " +
  "Returns matching path:line:text lines.",
  {
    pattern: z.string().min(1).describe("Search pattern. Treated as a literal string (use grep_regex for regex)."),
    files: z.string().optional().describe("Optional path-glob to scope the search, e.g. 'app/**'."),
    regex: z.boolean().optional().describe("If true, pattern is a regular expression. Default false."),
    max_matches: z.number().int().positive().max(500).optional().describe("Default 100."),
  },
  async (input) => {
    try {
      const maxMatches = input.max_matches ?? 100;
      const flags = ["-n", "--no-color"];
      if (!input.regex) flags.push("-F");
      let matches: string[];

      if (isInGitRepo()) {
        const args = ["-C", ROOT, "grep", ...flags, input.pattern];
        if (input.files) args.push("--", input.files);
        const out = spawnSync("git", args, { maxBuffer: 50 * 1024 * 1024 });
        matches = (out.status === 0 || out.status === 1)
          ? out.stdout.toString("utf-8").split("\n").filter((l) => l.length > 0)
          : [];
      } else {
        const args = ["-rn", "--no-color"];
        if (!input.regex) args.push("-F");
        for (const dir of FORBIDDEN_DIRS) args.push(`--exclude-dir=${dir}`);
        args.push(input.pattern, input.files ?? ".");
        const out = spawnSync("grep", args, { cwd: ROOT, maxBuffer: 50 * 1024 * 1024 });
        matches = (out.status === 0 || out.status === 1)
          ? out.stdout.toString("utf-8").split("\n").filter((l) => l.length > 0)
          : [];
      }

      const truncated = matches.length > maxMatches;
      return jsonResult({
        ok: true,
        pattern: input.pattern,
        count: Math.min(matches.length, maxMatches),
        total: matches.length,
        truncated,
        matches: truncated ? matches.slice(0, maxMatches) : matches,
      });
    } catch (err) {
      return jsonResult({ ok: false, error: (err as Error).message });
    }
  },
);

// ─── diff ───────────────────────────────────────────────────────────

server.tool(
  "diff",
  "Show pending uncommitted changes in the working copy. Uses 'git diff HEAD' when available; " +
  "for non-git working copies, returns a hint that diff is unavailable. Use this to verify the " +
  "edits you just made before reporting back to the user.",
  {},
  async () => {
    try {
      if (!isInGitRepo()) {
        return jsonResult({ ok: true, available: false, reason: "not a git repository" });
      }
      const out = spawnSync("git", ["-C", ROOT, "diff", "HEAD"], { maxBuffer: 50 * 1024 * 1024 });
      if (out.status !== 0 && out.status !== 1) {
        return jsonResult({ ok: false, error: `git diff failed: ${out.stderr.toString("utf-8")}` });
      }
      const diff = out.stdout.toString("utf-8");
      // Cap the response — a massive diff blows the model's context.
      const cap = 50_000;
      const truncated = diff.length > cap;
      return textResult(truncated ? diff.slice(0, cap) + "\n\n[...truncated]" : diff);
    } catch (err) {
      return jsonResult({ ok: false, error: (err as Error).message });
    }
  },
);

// ─── boot ───────────────────────────────────────────────────────────

console.error(`[webstudio-mcp] root=${ROOT}, git=${isInGitRepo() ? "yes" : "no"}`);
const transport = new StdioServerTransport();
await server.connect(transport);
