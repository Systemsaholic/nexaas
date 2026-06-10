/**
 * nexaas upgrade — move the framework to a new ref and apply pending migrations.
 *
 * Three ways to pick the target ref (#214):
 *   - Release channel (`--channel stable|canary`, persisted in workspace_kv):
 *     upgrades to origin/channel/<name> HEAD. Channel branches are
 *     fast-forwarded by ops to annotated release tags — clients on a channel
 *     only ever run tagged releases, never main. See docs/releases.md.
 *   - Pinned tag (`--to vX.Y.Z`): the hotfix-push path — ops SSHes in and
 *     applies a specific tag directly, with or without a channel configured.
 *   - Legacy (no channel persisted, no flags): pull origin/<current-branch>.
 *     Pre-channel deployments keep their exact behavior.
 *
 * Safety rails (#214):
 *   - Before HEAD moves, the running ref is recorded in workspace_kv
 *     (framework_previous_ref) and nexaas_memory.framework_versions, so
 *     `--rollback` and the conformance gate always have a return address.
 *   - After the post-restart health check passes, `nexaas conformance --json`
 *     runs as a gate. A failing suite (exit 1) auto-rolls back to the
 *     recorded previous ref. `--no-verify` skips the gate (emergencies only).
 *   - Rollback is code-only: migrations are NOT reverted. Policy: every
 *     migration must be backward-compatible one release (see docs/releases.md).
 *
 * Steps:
 *   1. Check current version
 *   2. Resolve target ref (channel / tag / tracking branch) and move HEAD
 *   3. npm install (if package.json changed)
 *   4. Build production JS
 *   5. Apply pending database migrations
 *   6. Restart worker
 *   7. Verify health, then run the conformance gate
 *
 * Usage:
 *   nexaas upgrade                       Upgrade (channel if configured, else tracking branch)
 *   nexaas upgrade --check               Check for updates without applying
 *   nexaas upgrade --migrate             Only apply pending migrations
 *   nexaas upgrade --channel stable      Switch to (and persist) the stable channel, then upgrade
 *   nexaas upgrade --channel canary      Switch to (and persist) the canary channel, then upgrade
 *   nexaas upgrade --to v0.3.1           Pin directly to a tag (hotfix push)
 *   nexaas upgrade --rollback            Return to the previously-running ref (code only)
 *   nexaas upgrade --no-verify           Skip the post-upgrade conformance gate
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import pg from "pg";
import { appendWal, getPool } from "@nexaas/palace";

const CHANNELS = ["stable", "canary"] as const;
const CONFORMANCE_TIMEOUT_MS = 600_000;

interface PreviousRef {
  sha: string;
  describe: string;
  branch: string | null;
  recorded_at: string;
}

function exec(cmd: string, opts?: { silent?: boolean; timeout?: number }): string {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: opts?.timeout ?? 60_000 }).trim();
  } catch (e) {
    if (!opts?.silent) throw e;
    return "";
  }
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return v;
}

function gitDescribe(nexaasRoot: string, ref = "HEAD"): string {
  return exec(`git -C ${nexaasRoot} describe --tags --always ${ref}`, { silent: true });
}

export async function run(args: string[]) {
  const checkOnly = args.includes("--check");
  const migrateOnly = args.includes("--migrate");
  const rollback = args.includes("--rollback");
  const noVerify = args.includes("--no-verify");
  const channelFlag = argValue(args, "--channel");
  const toTag = argValue(args, "--to");
  const workspace = process.env.NEXAAS_WORKSPACE ?? "";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const nexaasRoot = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

  if (!workspace || !dbUrl) {
    console.error("NEXAAS_WORKSPACE and DATABASE_URL required");
    process.exit(1);
  }

  if (channelFlag && !(CHANNELS as readonly string[]).includes(channelFlag)) {
    console.error(`--channel must be one of: ${CHANNELS.join(", ")}`);
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  if (rollback) {
    console.log("\n  Nexaas Rollback\n");
    const ok = await doRollback(pool, workspace, nexaasRoot, "operator_requested");
    console.log("");
    await pool.end();
    await endPalacePool();
    process.exit(ok ? 0 : 1);
  }

  console.log("\n  Nexaas Upgrade\n");

  // Step 1: Check current version
  const currentCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });
  const currentBranch = exec(`git -C ${nexaasRoot} rev-parse --abbrev-ref HEAD`, { silent: true });
  console.log(`  Current: ${currentCommit} (${currentBranch})`);

  // Resolve the release channel: explicit flag wins and is persisted;
  // otherwise use whatever workspace_kv has. Pre-014 installs without the
  // kv table fall through to null — pure legacy behavior.
  let persistedChannel: string | null = null;
  try {
    const r = await pool.query(
      `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'framework_channel'`,
      [workspace],
    );
    persistedChannel = (r.rows[0]?.value as string | undefined) ?? null;
  } catch { /* workspace_kv missing — legacy install */ }

  if (channelFlag && !checkOnly && channelFlag !== persistedChannel) {
    try {
      await pool.query(
        `INSERT INTO nexaas_memory.workspace_kv (workspace, key, value)
         VALUES ($1, 'framework_channel', $2)
         ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value`,
        [workspace, channelFlag],
      );
      console.log(`  Channel: ${channelFlag} (persisted)`);
    } catch (e) {
      console.error(`  Could not persist channel (workspace_kv unavailable): ${(e as Error).message}`);
      console.error("  Run migrations first: nexaas upgrade --migrate");
      await pool.end();
      process.exit(1);
    }
  } else if (persistedChannel && !channelFlag) {
    console.log(`  Channel: ${persistedChannel}`);
  }

  const channel = channelFlag ?? persistedChannel;

  let refChanged = false;
  let fromDescribe = gitDescribe(nexaasRoot);

  if (!migrateOnly) {
    if (toTag || channel) {
      // ── Pinned path: channel ref or explicit tag → fetch + detached
      // checkout of the resolved SHA. The legacy `git pull` path must not
      // run here: a channel/tag checkout is detached HEAD and pull would
      // fail (or worse, merge). ──
      const label = toTag ?? `channel/${channel}`;
      exec(`git -C ${nexaasRoot} fetch origin --tags --quiet`, { silent: true, timeout: 120_000 });
      if (!toTag) {
        exec(
          `git -C ${nexaasRoot} fetch origin +refs/heads/channel/${channel}:refs/remotes/origin/channel/${channel} --quiet`,
          { silent: true, timeout: 120_000 },
        );
      }

      const targetSha = exec(
        toTag
          ? `git -C ${nexaasRoot} rev-parse ${toTag}^{commit}`
          : `git -C ${nexaasRoot} rev-parse origin/channel/${channel}`,
        { silent: true },
      );
      if (!targetSha) {
        console.error(toTag
          ? `  Tag '${toTag}' not found on origin. Check the tag name (nexaas upgrade --to vX.Y.Z).`
          : `  Channel branch 'channel/${channel}' not found on origin — has ops published it yet?`);
        await pool.end();
        process.exit(1);
      }

      const headSha = exec(`git -C ${nexaasRoot} rev-parse HEAD`, { silent: true });
      const targetDescribe = gitDescribe(nexaasRoot, targetSha) || targetSha.slice(0, 7);

      if (targetSha === headSha) {
        console.log(`  Status: up to date (${label} @ ${targetDescribe})`);
      } else {
        const behind = exec(`git -C ${nexaasRoot} rev-list HEAD..${targetSha} --count`, { silent: true });
        const behindCount = parseInt(behind, 10) || 0;
        const delta = behindCount > 0 ? `${behindCount} new commit(s)` : "downgrade or divergent history";
        console.log(`  Status: ${label} is at ${targetDescribe} (${delta})`);

        const newCommits = exec(
          `git -C ${nexaasRoot} log --oneline HEAD..${targetSha} | head -10`,
          { silent: true },
        );
        if (newCommits) {
          console.log("\n  New commits:");
          for (const line of newCommits.split("\n")) {
            console.log(`    ${line}`);
          }
        }
      }

      if (checkOnly) {
        const pending = await getPendingMigrations(pool, nexaasRoot);
        if (pending.length > 0) {
          console.log(`\n  Pending migrations: ${pending.length}`);
          for (const m of pending) console.log(`    ${m}`);
        }
        console.log("");
        await pool.end();
        return;
      }

      if (targetSha !== headSha) {
        await recordPreviousRef(pool, workspace, nexaasRoot);
        console.log(`\n  Checking out ${label} (${targetDescribe})...`);
        exec(`git -C ${nexaasRoot} checkout --detach ${targetSha} --quiet`, { timeout: 120_000 });
        refChanged = true;
        postCheckoutSteps(nexaasRoot, currentCommit);
        maybeMigrateSystemdUnit(nexaasRoot);
      }
    } else {
      // ── Legacy path: no channel configured, no pin — track the current
      // branch exactly as before #214. Byte-for-byte unchanged. ──
      if (currentBranch === "HEAD") {
        console.error("  Repo is in detached HEAD with no channel configured.");
        console.error("  Use --channel stable|canary, --to <tag>, or --rollback.");
        await pool.end();
        process.exit(1);
      }

      // Step 2: Check for updates
      exec(`git -C ${nexaasRoot} fetch origin ${currentBranch} --quiet`, { silent: true });
      const behind = exec(`git -C ${nexaasRoot} rev-list HEAD..origin/${currentBranch} --count`, { silent: true });
      const behindCount = parseInt(behind, 10) || 0;

      if (behindCount === 0) {
        console.log("  Status: up to date");
      } else {
        console.log(`  Status: ${behindCount} commit(s) behind origin/${currentBranch}`);

        const newCommits = exec(
          `git -C ${nexaasRoot} log --oneline HEAD..origin/${currentBranch} | head -10`,
          { silent: true },
        );
        if (newCommits) {
          console.log("\n  New commits:");
          for (const line of newCommits.split("\n")) {
            console.log(`    ${line}`);
          }
        }
      }

      if (checkOnly) {
        // Check pending migrations
        const pending = await getPendingMigrations(pool, nexaasRoot);
        if (pending.length > 0) {
          console.log(`\n  Pending migrations: ${pending.length}`);
          for (const m of pending) console.log(`    ${m}`);
        }
        console.log("");
        await pool.end();
        return;
      }

      if (behindCount > 0) {
        await recordPreviousRef(pool, workspace, nexaasRoot);

        // Step 3: Pull
        console.log("\n  Pulling latest...");
        const pullResult = exec(`git -C ${nexaasRoot} pull origin ${currentBranch}`, { timeout: 120_000 });
        console.log(`  ${pullResult.split("\n").pop()}`);
        refChanged = true;

        postCheckoutSteps(nexaasRoot, currentCommit);

        // Step 4c: Auto-migrate the systemd unit if it's still on the old
        // tsx-based ExecStart. New installs (#37) write the compiled-JS
        // form directly; existing installs flip on first upgrade.
        maybeMigrateSystemdUnit(nexaasRoot);
      }
    }
  }

  // Step 5: Apply pending migrations.
  //
  // Each migration runs inside its own transaction with the schema_migrations
  // marker INSERT — atomic apply + record. If the SQL fails partway, the
  // marker rolls back too. This prevents the failure mode in #72 where the
  // marker outlasted a failed apply and the dispatcher silently broke for
  // days waiting on a table that was recorded as created but didn't exist.
  const pending = await getPendingMigrations(pool, nexaasRoot);
  if (pending.length > 0) {
    console.log(`\n  Applying ${pending.length} migration(s)...`);
    for (const migration of pending) {
      const sqlPath = join(nexaasRoot, "database/migrations", migration);
      const sqlContent = readFileSync(sqlPath, "utf-8");
      const client = await pool.connect();
      let migrationFailed = false;
      try {
        await client.query("BEGIN");
        await client.query(sqlContent);
        await client.query(
          `INSERT INTO nexaas_memory.schema_migrations (filename, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`,
          [migration],
        );
        await client.query("COMMIT");
        console.log(`    ✓ ${migration}`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => { /* best effort */ });
        console.error(`    ✗ ${migration}: ${(e as Error).message}`);
        console.error("  Migration failed — stopping. Fix the issue and run 'nexaas upgrade --migrate'");
        migrationFailed = true;
      } finally {
        client.release();
      }
      // Exit AFTER release so the connection always returns to the pool —
      // process.exit doesn't run finally on the *outer* scope, but we already
      // released in the inner finally. Belt and suspenders: see PR #77 review.
      if (migrationFailed) process.exit(1);
    }
  } else {
    console.log("  Migrations: up to date");
  }

  let healthy = false;
  if (!migrateOnly) {
    // Step 6: Restart worker
    console.log("\n  Restarting worker...");
    restartWorker();

    // Step 7: Verify health (wait a bit)
    console.log("  Waiting for health check...");
    healthy = waitForHealth();

    const newCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });

    if (healthy) {
      console.log(`\n  ✓ Upgrade complete: ${currentCommit} → ${newCommit}`);
    } else {
      console.log(`\n  ⚠ Upgraded to ${newCommit} but health check did not pass`);
      console.log("    Check: nexaas status");
    }
  }

  // Step 8: Post-upgrade conformance gate (#214). Only when the ref actually
  // moved and the worker came back healthy — a no-op upgrade or a
  // migrate-only run never triggers the gate, so legacy boxes that are
  // already up to date see zero behavior change.
  let gateOutcome: "passed" | "skipped" | "could_not_run" | "not_run" = "not_run";
  if (!migrateOnly && refChanged && healthy && !noVerify) {
    console.log("\n  Running conformance gate (nexaas conformance --json)...");
    const gate = spawnSync(
      process.execPath,
      [...process.execArgv, process.argv[1], "conformance", "--json"],
      { encoding: "utf-8", timeout: CONFORMANCE_TIMEOUT_MS, env: process.env },
    );

    let summary: unknown = null;
    try {
      summary = (JSON.parse(gate.stdout ?? "null") as { summary?: unknown })?.summary ?? null;
    } catch { /* non-JSON output — keep null */ }

    if (gate.status === 0) {
      gateOutcome = "passed";
      console.log("  ✓ Conformance gate passed");
    } else if (gate.status === 1) {
      const toDescribe = gitDescribe(nexaasRoot);
      console.error("\n  ✗ Conformance gate FAILED on the new release — rolling back.");
      console.error(`    Failed ref: ${toDescribe}`);
      console.error("    Re-run 'nexaas conformance' after rollback to confirm the previous release is healthy.");
      await safeAppendWal({
        workspace,
        op: "upgrade_conformance_failed",
        actor: "cli:upgrade",
        payload: {
          attempted_ref: toDescribe,
          from_ref: fromDescribe,
          channel: channel ?? null,
          pinned_tag: toTag ?? null,
          conformance_summary: summary,
        },
      });
      await recordVersionHistory(pool, workspace, {
        version: toDescribe,
        prior: fromDescribe,
        status: "conformance_failed",
        smoke: summary,
      });
      const rolledBack = await doRollback(pool, workspace, nexaasRoot, "conformance_failed");
      if (!rolledBack) {
        console.error("  ✗ Automatic rollback FAILED — manual intervention required (see above).");
      }
      console.log("");
      await pool.end();
      await endPalacePool();
      process.exit(1);
    } else {
      // Exit 2 = conformance could not run (env/DB problems); timeouts and
      // spawn errors land here too. Not proof of a bad release — warn, keep.
      gateOutcome = "could_not_run";
      console.log(`  ⚠ Conformance gate could not run (exit ${gate.status ?? "timeout"}) — upgrade kept.`);
      console.log("    Run manually: nexaas conformance");
    }
  } else if (!migrateOnly && refChanged && noVerify) {
    gateOutcome = "skipped";
    console.log("  ⚠ Conformance gate skipped (--no-verify)");
  }

  // Record the successful ref change durably: WAL for audit, plus a
  // framework_versions row for per-workspace upgrade history (#214).
  if (!migrateOnly && refChanged) {
    const toDescribe = gitDescribe(nexaasRoot);
    await safeAppendWal({
      workspace,
      op: "framework_upgraded",
      actor: "cli:upgrade",
      payload: {
        from_ref: fromDescribe,
        to_ref: toDescribe,
        from_commit: currentCommit,
        to_commit: exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true }),
        channel: channel ?? null,
        pinned_tag: toTag ?? null,
        healthy,
        conformance_gate: gateOutcome,
      },
    });
    await recordVersionHistory(pool, workspace, {
      version: toDescribe,
      prior: fromDescribe,
      status: "installed",
      smoke: { healthy, conformance_gate: gateOutcome },
    });
  }

  // The restarted worker fires a startup heartbeat to the fleet dashboard
  // within ~5s of coming up (see packages/runtime/src/fleet/heartbeat.ts).
  // Poll `framework_heartbeat.last_push_at` briefly so the operator can see
  // confirmation before the command exits.
  if (!migrateOnly) {
    try {
      let confirmed = false;
      for (let i = 0; i < 6; i++) {
        execSync("sleep 2", { stdio: "pipe" });
        const row = await pool.query(
          `SELECT version, commit_sha, last_push_at, last_push_status
           FROM nexaas_memory.framework_heartbeat WHERE workspace = $1`,
          [workspace],
        );
        const hb = row.rows[0];
        if (hb?.last_push_at && (Date.now() - new Date(hb.last_push_at).getTime()) < 30_000) {
          console.log(`  ✓ Fleet heartbeat: ${hb.version} (${hb.commit_sha}) — ${hb.last_push_status}`);
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        console.log("  ⚠ Fleet heartbeat not seen yet — check NEXAAS_FLEET_ENDPOINT / NEXAAS_FLEET_TOKEN in .env if the dashboard doesn't pick up the new version.");
      }
    } catch (err) {
      // framework_heartbeat table missing → pre-015 install. No action.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("framework_heartbeat")) {
        console.log(`  ⚠ Heartbeat confirmation skipped: ${msg.slice(0, 120)}`);
      }
    }
  }

  console.log("");
  await pool.end();
  await endPalacePool();
}

/**
 * Steps 3 + 4b after HEAD moved (shared by the pull, channel, tag, and
 * rollback paths): npm install when the dependency manifests changed, then
 * compile TS → JS for production (#37). The systemd unit runs compiled JS
 * via `node --conditions=production dist/worker.js`. Build is fast (<10s on
 * a warm cache) and skipped only when no source files changed.
 */
function postCheckoutSteps(nexaasRoot: string, fromCommit: string): void {
  const changedFiles = exec(
    `git -C ${nexaasRoot} diff --name-only ${fromCommit}..HEAD`,
    { silent: true },
  );
  if (changedFiles.includes("package.json") || changedFiles.includes("package-lock.json")) {
    console.log("  Running npm install...");
    exec(`cd ${nexaasRoot} && npm install --production 2>/dev/null`, { timeout: 300_000 });
    console.log("  Dependencies updated");
  }

  const sourceChanged = changedFiles.split("\n").some((f) => /^(packages|integrations|mcp\/servers)\/[^/]+\/(src|tsconfig)/.test(f));
  if (sourceChanged || !existsSync(join(nexaasRoot, "packages/runtime/dist/worker.js"))) {
    console.log("  Building production JS...");
    exec(`cd ${nexaasRoot} && npm run build`, { timeout: 300_000 });
    if (!existsSync(join(nexaasRoot, "packages/runtime/dist/worker.js"))) {
      console.error("  Build failed — packages/runtime/dist/worker.js missing.");
      process.exit(1);
    }
    console.log("  Build complete");
  }
}

function restartWorker(): void {
  try {
    exec("sudo systemctl restart nexaas-worker", { timeout: 30_000 });
  } catch {
    exec("systemctl restart nexaas-worker", { timeout: 30_000, silent: true });
  }
}

function waitForHealth(): boolean {
  for (let i = 0; i < 6; i++) {
    execSync("sleep 5", { stdio: "pipe" });
    const health = exec("curl -sf --max-time 3 http://localhost:9090/health", { silent: true });
    if (health) {
      try {
        const parsed = JSON.parse(health);
        if (parsed.status === "healthy") return true;
      } catch { /* try again */ }
    }
  }
  return false;
}

/**
 * Persist the currently-running ref before HEAD moves (#214). This is the
 * return address for `--rollback` and the conformance gate's auto-rollback,
 * so it must land BEFORE any checkout — if it can't be written, the operator
 * is warned that rollback won't be available for this upgrade.
 */
async function recordPreviousRef(pool: pg.Pool, workspace: string, nexaasRoot: string): Promise<void> {
  const branch = exec(`git -C ${nexaasRoot} rev-parse --abbrev-ref HEAD`, { silent: true });
  const value: PreviousRef = {
    sha: exec(`git -C ${nexaasRoot} rev-parse HEAD`, { silent: true }),
    describe: gitDescribe(nexaasRoot),
    branch: branch === "HEAD" ? null : branch,
    recorded_at: new Date().toISOString(),
  };
  try {
    await pool.query(
      `INSERT INTO nexaas_memory.workspace_kv (workspace, key, value)
       VALUES ($1, 'framework_previous_ref', $2)
       ON CONFLICT (workspace, key) DO UPDATE SET value = EXCLUDED.value`,
      [workspace, JSON.stringify(value)],
    );
  } catch (e) {
    console.log(`  ⚠ Could not record previous ref — rollback will not be available for this upgrade (${(e as Error).message.slice(0, 80)})`);
  }
}

async function readPreviousRef(pool: pg.Pool, workspace: string): Promise<PreviousRef | null> {
  try {
    const r = await pool.query(
      `SELECT value FROM nexaas_memory.workspace_kv WHERE workspace = $1 AND key = 'framework_previous_ref'`,
      [workspace],
    );
    const raw = r.rows[0]?.value as string | undefined;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PreviousRef;
    return parsed?.sha ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Code-only rollback to the recorded previous ref (#214): checkout, rebuild,
 * restart, health-check, WAL `framework_rolled_back`. Migrations are NOT
 * reverted — policy is that every migration must keep the previous release's
 * code working (one-release backward compatibility, see docs/releases.md).
 *
 * After rolling back, the ref we rolled back FROM becomes the new
 * framework_previous_ref, so a mistaken rollback can be rolled forward with
 * a second `nexaas upgrade --rollback`.
 */
async function doRollback(
  pool: pg.Pool,
  workspace: string,
  nexaasRoot: string,
  reason: string,
): Promise<boolean> {
  const prev = await readPreviousRef(pool, workspace);
  if (!prev) {
    console.error("  No previous ref recorded (workspace_kv framework_previous_ref) — nothing to roll back to.");
    console.error("  Rollback targets are recorded by upgrades that move HEAD; pin a known-good tag instead:");
    console.error("    nexaas upgrade --to vX.Y.Z --no-verify");
    return false;
  }

  const fromCommit = exec(`git -C ${nexaasRoot} rev-parse --short HEAD`, { silent: true });
  const fromDescribe = gitDescribe(nexaasRoot);
  console.log(`  Rolling back: ${fromDescribe} → ${prev.describe} (${reason})`);
  console.log("  Note: migrations are NOT reverted — schema stays at the newer version.");

  // Re-record the ref we're leaving so the rollback itself can be undone.
  await recordPreviousRef(pool, workspace, nexaasRoot);

  // Check out the previous ref: re-attach to the branch when it still points
  // at the recorded SHA (legacy tracking-branch installs), otherwise detach.
  try {
    const branchSha = prev.branch
      ? exec(`git -C ${nexaasRoot} rev-parse ${prev.branch}`, { silent: true })
      : "";
    if (prev.branch && branchSha === prev.sha) {
      exec(`git -C ${nexaasRoot} checkout ${prev.branch} --quiet`, { timeout: 120_000 });
    } else {
      exec(`git -C ${nexaasRoot} checkout --detach ${prev.sha} --quiet`, { timeout: 120_000 });
    }
  } catch (e) {
    console.error(`  ✗ Checkout of ${prev.sha.slice(0, 7)} failed: ${(e as Error).message.slice(0, 200)}`);
    return false;
  }

  postCheckoutSteps(nexaasRoot, fromCommit);

  console.log("\n  Restarting worker...");
  restartWorker();
  console.log("  Waiting for health check...");
  const healthy = waitForHealth();

  await safeAppendWal({
    workspace,
    op: "framework_rolled_back",
    actor: "cli:upgrade",
    payload: {
      from_ref: fromDescribe,
      to_ref: prev.describe,
      from_commit: fromCommit,
      to_commit: prev.sha.slice(0, 7),
      reason,
      healthy,
    },
  });
  await recordVersionHistory(pool, workspace, {
    version: prev.describe,
    prior: fromDescribe,
    status: "rolled_back",
    smoke: { healthy, reason },
  });

  if (healthy) {
    console.log(`\n  ✓ Rolled back: ${fromDescribe} → ${prev.describe}`);
  } else {
    console.log(`\n  ⚠ Rolled back to ${prev.describe} but health check did not pass`);
    console.log("    Check: nexaas status");
  }
  return healthy;
}

/**
 * Per-workspace upgrade history in nexaas_memory.framework_versions (012).
 * Best-effort: history must never block an upgrade or a rollback.
 */
async function recordVersionHistory(
  pool: pg.Pool,
  workspace: string,
  row: { version: string; prior: string | null; status: string; smoke?: unknown },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO nexaas_memory.framework_versions
         (workspace, package_name, version, prior_version, smoke_test_result, status)
       VALUES ($1, 'nexaas', $2, $3, $4, $5)`,
      [workspace, row.version || "unknown", row.prior || null, row.smoke ? JSON.stringify(row.smoke) : null, row.status],
    );
  } catch { /* table missing on pre-012 installs — skip */ }
}

/** WAL append that never blocks the upgrade path. */
async function safeAppendWal(entry: Parameters<typeof appendWal>[0]): Promise<void> {
  try {
    await appendWal(entry);
  } catch (e) {
    console.log(`  ⚠ WAL append failed (non-fatal): ${(e as Error).message.slice(0, 120)}`);
  }
}

/**
 * appendWal goes through the palace's shared pool, which keeps idle clients
 * for 30s and would hold the process open after the command finishes. Ending
 * it is safe even when no WAL write happened (the pool is created lazily and
 * ends without ever having connected).
 */
async function endPalacePool(): Promise<void> {
  try {
    await getPool().end();
  } catch { /* already ended or never created */ }
}

/**
 * Flip an existing nexaas-worker.service from the legacy tsx ExecStart
 * to the compiled-JS form (#37). One-shot: detects the old `node tsx
 * .../src/worker.ts` invocation and rewrites it to
 * `node --conditions=production .../dist/worker.js`. No-op once
 * migrated. The unit ships compiled-by-default for new installs.
 */
function maybeMigrateSystemdUnit(nexaasRoot: string): void {
  const unitPath = "/etc/systemd/system/nexaas-worker.service";
  if (!existsSync(unitPath)) return;

  let unit: string;
  try {
    unit = readFileSync(unitPath, "utf-8");
  } catch {
    return; // No permission to read — leave alone.
  }

  // Already migrated.
  if (unit.includes("--conditions=production") && unit.includes("dist/worker.js")) return;

  // Match the legacy form: `ExecStart=<node> <tsx> .../packages/runtime/src/worker.ts`
  const legacy = /^ExecStart=(\S+)\s+\S+tsx\S*\s+\S+\/packages\/runtime\/src\/worker\.ts.*$/m;
  const m = unit.match(legacy);
  if (!m) return; // Some other custom form — don't touch.

  const nodeBin = m[1]!;
  const newExecStart = `ExecStart=${nodeBin} --conditions=production ${nexaasRoot}/packages/runtime/dist/worker.js`;
  const migrated = unit.replace(legacy, newExecStart);

  console.log("\n  Migrating systemd unit to compiled-JS ExecStart (#37)...");
  try {
    exec(`sudo tee ${unitPath} > /dev/null <<'NEXAAS_UNIT_EOF'\n${migrated}\nNEXAAS_UNIT_EOF`);
    exec("sudo systemctl daemon-reload");
    console.log("  Systemd unit migrated");
  } catch (e) {
    console.error(`  Systemd unit migration failed (will retry next upgrade): ${(e as Error).message}`);
  }
}

async function getPendingMigrations(pool: pg.Pool, nexaasRoot: string): Promise<string[]> {
  const migrationsDir = join(nexaasRoot, "database/migrations");
  if (!existsSync(migrationsDir)) return [];

  const allFiles = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  let applied: Set<string>;
  try {
    // Ensure tracking table exists.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nexaas_memory.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // No seed-all heuristic. The previous "if schema_migrations is empty and
    // nexaas_memory has >5 tables, mark every migration as applied" path was
    // the root cause of #72 — it stamped migrations that init.ts never ran
    // (e.g. 016/017 added after the workspace was set up) as applied without
    // executing their SQL. All migrations use CREATE TABLE/INDEX IF NOT
    // EXISTS, so re-running them on a workspace whose tables were created by
    // init.ts is safe (idempotent) and self-heals the schema_migrations row
    // set on the first post-fix upgrade.

    const result = await pool.query(`SELECT filename FROM nexaas_memory.schema_migrations`);
    applied = new Set(result.rows.map(r => r.filename));
  } catch {
    applied = new Set();
  }

  return allFiles.filter(f => !applied.has(f));
}
