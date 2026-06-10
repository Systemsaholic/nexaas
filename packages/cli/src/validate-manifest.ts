/**
 * nexaas validate-manifest — validate the workspace manifest the provisioner
 * delivered, before declaring an install done (#218).
 *
 * The worker's manifest loader is fail-open by design (a malformed manifest
 * must not halt a running workspace), which means delivery mistakes surface
 * as runtime warnings nobody reads. This command gives the zero-touch
 * provisioning pipeline a fail-CLOSED checkpoint: drop the manifest at
 * ${NEXAAS_WORKSPACE_MANIFEST_DIR}/<workspace>.workspace.json, run this,
 * and gate on the exit code.
 *
 * Exit codes: 0 = valid (warnings allowed, printed), 1 = schema errors,
 *             2 = manifest file missing.
 *
 * Usage:
 *   nexaas validate-manifest                 Validate $NEXAAS_WORKSPACE's manifest
 *   nexaas validate-manifest <workspace-id>  Validate a specific workspace's manifest
 */

import { existsSync } from "fs";
import { join } from "path";
import { loadWorkspaceManifest, getManifestDir } from "@nexaas/runtime";

export async function run(args: string[] = []) {
  const workspace = args.find((a) => !a.startsWith("--")) ?? process.env.NEXAAS_WORKSPACE;
  if (!workspace) {
    console.error("Usage: nexaas validate-manifest [workspace-id]  (or set NEXAAS_WORKSPACE)");
    process.exit(2);
  }

  const manifestPath = join(getManifestDir(), `${workspace}.workspace.json`);
  console.log(`\n  Validating ${manifestPath}\n`);

  if (!existsSync(manifestPath)) {
    console.error(`  ✗ Manifest file not found.`);
    console.error(`    Manifest dir: ${getManifestDir()} (override: NEXAAS_WORKSPACE_MANIFEST_DIR)`);
    console.error(`    A workspace can run without a manifest (fail-open), but a provisioner`);
    console.error(`    that intended to deliver one should treat this as a failed delivery.\n`);
    process.exit(2);
  }

  const result = await loadWorkspaceManifest(workspace);

  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  for (const e of result.errors) console.error(`  ✗ ${e}`);

  if (!result.manifest) {
    console.error(`\n  ✗ Manifest invalid — ${result.errors.length} error(s). The worker would fail-open and ignore it.\n`);
    process.exit(1);
  }

  console.log(`\n  ✓ Manifest valid (${result.warnings.length} warning(s))\n`);
  process.exit(0);
}
