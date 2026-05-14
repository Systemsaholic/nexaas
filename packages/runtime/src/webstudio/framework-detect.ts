/**
 * Framework detection for Web Studio's git-import path (#147).
 *
 * Inspects a cloned repo's package.json and picks the right dev-server
 * command. Pure / no side effects so it's unit-testable without a real
 * git clone.
 *
 * Falls back to `static` when no recognized framework is detected — the
 * caller can then serve the working copy with the same static-serve used
 * by the scrape path.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type Framework = "next" | "vite" | "cra" | "gatsby" | "static";

export interface FrameworkDetection {
  framework: Framework;
  // Command + args to spawn the dev server. `static` returns null —
  // caller handles fallback via the scrape path's `serve`.
  devCommand: { command: string; args: string[] } | null;
  // Detected package manager (lockfile-based). `npm` is the default fallback.
  packageManager: "npm" | "pnpm" | "yarn";
  // Whether to use `ci` install (lockfile present) vs `install`.
  hasLockfile: boolean;
}

export function detectFramework(repoRoot: string): FrameworkDetection {
  const packageManager = detectPackageManager(repoRoot);
  const hasLockfile = packageManager !== "npm"
    || existsSync(join(repoRoot, "package-lock.json"));

  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    return { framework: "static", devCommand: null, packageManager, hasLockfile };
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return { framework: "static", devCommand: null, packageManager, hasLockfile };
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};

  // Order matters: Next.js takes precedence over react/vite since
  // Next.js apps frequently depend on react too. Gatsby before react
  // for the same reason.
  if ("next" in allDeps) {
    return {
      framework: "next",
      devCommand: scriptOrFallback(scripts, "dev", packageManager, ["next", "dev", "--port", "3002"]),
      packageManager,
      hasLockfile,
    };
  }
  if ("gatsby" in allDeps) {
    return {
      framework: "gatsby",
      devCommand: scriptOrFallback(scripts, "develop", packageManager, ["gatsby", "develop", "--port", "3002"]),
      packageManager,
      hasLockfile,
    };
  }
  if ("vite" in allDeps) {
    return {
      framework: "vite",
      devCommand: scriptOrFallback(scripts, "dev", packageManager, ["vite", "--port", "3002"]),
      packageManager,
      hasLockfile,
    };
  }
  if ("react-scripts" in allDeps) {
    return {
      framework: "cra",
      // CRA insists on its own port logic; PORT env is the only stable knob.
      devCommand: scriptOrFallback(scripts, "start", packageManager, ["react-scripts", "start"]),
      packageManager,
      hasLockfile,
    };
  }

  return { framework: "static", devCommand: null, packageManager, hasLockfile };
}

function detectPackageManager(repoRoot: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

// Prefer a script defined in package.json (e.g. `npm run dev`) over the
// raw binary invocation — projects often need bespoke flags that the
// script wraps. Fall back to the raw command if the script is missing.
function scriptOrFallback(
  scripts: Record<string, string>,
  scriptName: string,
  pm: "npm" | "pnpm" | "yarn",
  fallback: string[],
): { command: string; args: string[] } {
  if (scripts[scriptName]) {
    const runArg = pm === "npm" ? "run" : pm === "yarn" ? "run" : "run";
    return { command: pm, args: [runArg, scriptName] };
  }
  return { command: "npx", args: ["-y", ...fallback] };
}
