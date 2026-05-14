/**
 * Path-safety primitive for the Web Studio MCP server.
 *
 * Resolves a model-supplied relative path against a configured repo
 * root and rejects anything that escapes — lexically (absolute paths,
 * `..` traversal) or via filesystem symlinks (#159). Also rejects
 * paths that land inside a forbidden directory, including via a
 * symlink that aliases one (e.g. `nice -> .git`).
 *
 * Exposed as `createSafePath(root)` so the validator can be tested
 * against a temporary tree without booting the full MCP server.
 */

import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, normalize, relative, resolve as resolvePath } from "path";

// Hard-block directories. These never make sense for a content-edit
// loop and writing into them silently corrupts the working copy.
export const FORBIDDEN_DIRS = [".git", "node_modules", ".next", "dist", "build", ".nuxt", ".svelte-kit"];

export function createSafePath(root: string): (input: string) => string {
  const ROOT = resolvePath(root);
  // Resolve the root itself once — if WEBSTUDIO_REPO_ROOT is a symlink
  // (e.g. /var/www/site -> /srv/sites/site), the post-resolution
  // prefix check below would otherwise fail for every valid path.
  const REAL_ROOT = realpathSync(ROOT);

  return function safePath(input: string): string {
    if (typeof input !== "string" || input.length === 0) {
      throw new Error("path must be a non-empty string");
    }
    if (isAbsolute(input)) {
      throw new Error(`path must be relative to repo root: '${input}'`);
    }
    const normalized = normalize(input);
    if (normalized.startsWith("..") || normalized.includes(`${"/"}..${"/"}`)) {
      throw new Error(`path escapes repo root: '${input}'`);
    }
    const abs = resolvePath(ROOT, normalized);
    if (abs !== ROOT && !abs.startsWith(ROOT + "/")) {
      throw new Error(`path escapes repo root: '${input}'`);
    }

    // Symlink check: lexical resolution above can't see that
    // `cool.txt -> /etc/passwd` escapes the root. Walk up to the
    // deepest existing ancestor, realpath that, and re-verify the
    // prefix against REAL_ROOT. Handles the write-new-file case
    // (target doesn't exist yet) by falling back to the parent dir.
    let probe = abs;
    while (!existsSync(probe)) probe = dirname(probe);
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      throw new Error(`path could not be resolved: '${input}'`);
    }
    const tail = relative(probe, abs);
    const realFull = tail.length === 0 ? realProbe : join(realProbe, tail);
    if (realFull !== REAL_ROOT && !realFull.startsWith(REAL_ROOT + "/")) {
      throw new Error(`path resolves outside repo root via symlink: '${input}'`);
    }

    // Forbidden-dir check on the POST-RESOLUTION relative path, so a
    // symlink like `safe_name -> .git` is caught too. The pre-resolution
    // first-segment check alone would miss it.
    const relSegments = relative(REAL_ROOT, realFull).split("/");
    for (const seg of relSegments) {
      if (FORBIDDEN_DIRS.includes(seg)) {
        throw new Error(`writes to '${seg}/' are forbidden`);
      }
    }

    return abs;
  };
}
