/**
 * nexaas version — report the installed framework version (#259).
 *
 * The VERSION file at NEXAAS_ROOT is the single runtime source of truth
 * (same value the fleet heartbeat reports); git describes the actual
 * checkout so channel drift / local commits are visible at a glance.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function git(root: string, args: string): string {
  try {
    return execSync(`git -C ${root} ${args}`, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

export async function run() {
  const root = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

  let version = "unknown";
  try {
    version = readFileSync(join(root, "VERSION"), "utf-8").trim() || "unknown";
  } catch { /* no VERSION file — pre-0.2 checkout or wrong NEXAAS_ROOT */ }

  const sha = git(root, "rev-parse --short HEAD");
  const describe = git(root, "describe --tags --always 2>/dev/null");
  const dirty = git(root, "status --porcelain") ? " (modified)" : "";

  console.log(`nexaas v${version}`);
  if (sha) {
    console.log(`  checkout: ${describe || sha}${dirty}`);
  }
  console.log(`  root:     ${root}`);
  console.log(`  node:     ${process.version}`);
}
