/**
 * BullMQ worker — processes skill step jobs through the pillar pipeline.
 *
 * Uses sandboxed processors for isolation: each job runs in a child process
 * with clean cgroup inheritance. Worker crashes kill the child, not the parent.
 * No setsid, no reparenting to PID 1, no orphan accumulation.
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnectionOpts } from "./connection.js";
import { runSkillStep } from "../pipeline.js";
import { runShellSkill, type ShellSkillManifest } from "../shell-skill.js";
import { runAiSkill, type AiSkillManifest } from "../ai-skill.js";
import { runTracker } from "../run-tracker.js";
import { palace, appendWal, sql } from "@nexaas/palace";
import type { SkillJobData } from "./queues.js";
import { isRateLimitError, extractCooldownMs, pauseQueueFor } from "./rate-limit.js";
import { startHeartbeatLoop, stopHeartbeatLoop } from "../fleet/heartbeat.js";
import { shutdownMcpPool } from "../mcp/pool.js";
import { withGroups, resolveConcurrencyGroups } from "../concurrency-groups.js";
import { readFileSync, existsSync } from "fs";
import { load as yamlLoad } from "js-yaml";
import { randomUUID } from "crypto";
import { buildTerminalDrawerPayload, isEphemeralPath } from "../skill-terminal.js";

let _worker: Worker | null = null;

export function startWorker(workspaceId: string, concurrency: number = 5): Worker {
  if (_worker) return _worker;

  // Fire the fleet heartbeat loop alongside the worker. Silent no-op if
  // NEXAAS_FLEET_ENDPOINT / NEXAAS_FLEET_TOKEN aren't set.
  startHeartbeatLoop();

  const queueName = `nexaas-skills-${workspaceId}`;

  _worker = new Worker(
    queueName,
    async (job: Job<SkillJobData>) => {
      const data = job.data;

      // Ensure workspace is set — scheduler templates may not persist data
      if (!data.workspace) {
        data.workspace = workspaceId;
      }

      // Generate a runId if not provided (cron-triggered jobs don't have one)
      if (!data.runId) {
        data.runId = randomUUID();
      }

      // Route to the right executor based on manifest execution type
      // Shell/AI skill executors create their own run records
      const jobData = data as SkillJobData & { manifestPath?: string };
      if (jobData.manifestPath) {
        // Phantom-skill guard (#172): the scheduler stored an absolute
        // manifestPath at registration time, but the file may have been
        // deleted, moved, or never persisted across a /tmp cleanup. Before
        // this guard, `readFileSync` threw ENOENT, BullMQ failed the job,
        // and no drawer / no skill_run row was ever produced — the
        // canonical "scheduler fires forever into the void" failure.
        // Now we synthesize a failed run + terminal drawer so dashboards
        // and silent-failure-watchdog (#69) see the event.
        if (!existsSync(jobData.manifestPath)) {
          await handleManifestMissing(data, jobData.manifestPath);
          // Throw so BullMQ marks the job failed and stops retrying the
          // same vanishing path forever. The job_failed listener below
          // will append its own WAL row.
          throw new Error(`manifest_missing: ${jobData.manifestPath}`);
        }
        const manifestContent = readFileSync(jobData.manifestPath, "utf-8");
        const manifest = yamlLoad(manifestContent) as Record<string, unknown>;
        const execType = (manifest.execution as Record<string, unknown>)?.type;

        // Forward BullMQ job context so the executor reuses the
        // dispatcher's runId and sees triggerType / triggerPayload (#47).
        // For cron-triggered jobs, data.triggerType is "cron" and
        // triggerPayload is undefined — behavior unchanged from pre-#47.
        const executionContext = {
          runId: data.runId,
          stepId: data.stepId,
          triggerType: data.triggerType,
          triggerPayload: data.triggerPayload,
        };

        // RFC #95 — skill-declared concurrency groups serialize across
        // shared resources (e.g. sqlite:data/onboarding.db). Skills
        // without `concurrency_groups` bypass the semaphore entirely.
        // #135 — `{field}` placeholders in group names are substituted
        // from trigger payload at dispatch time, letting a manifest
        // declare per-payload isolation like `pa-notify:{user}:{thread_id}`.
        const rawGroups = (manifest as { concurrency_groups?: string[] })
          .concurrency_groups;
        const groups = resolveConcurrencyGroups(
          rawGroups,
          data.triggerPayload as Record<string, unknown> | undefined,
        );
        const lockMeta = {
          workspace: data.workspace,
          skillId: data.skillId,
          runId: data.runId,
        };

        if (execType === "shell") {
          await withGroups(
            groups,
            () =>
              runShellSkill(
                data.workspace,
                manifest as unknown as ShellSkillManifest,
                executionContext,
              ),
            lockMeta,
          );
          return;
        }

        if (execType === "ai-skill") {
          // Hoist out of `jobData` so the closure passed to withGroups()
          // doesn't lose TS narrowing across the function boundary.
          const manifestPath = jobData.manifestPath;
          try {
            await withGroups(
              groups,
              () =>
                runAiSkill(
                  data.workspace,
                  manifest as unknown as AiSkillManifest,
                  manifestPath,
                  executionContext,
                ),
              lockMeta,
            );
          } catch (err) {
            if (isRateLimitError(err)) {
              const cooldownMs = extractCooldownMs(err);
              await pauseQueueFor(
                data.workspace,
                cooldownMs,
                `anthropic-429 on skill ${data.skillId}`,
              );
            }
            throw err;
          }
          return;
        }
      }

      // Pillar pipeline path — create run record here (shell/AI executors create their own)
      if (!data.resumedWith) {
        try {
          await runTracker.createRun({
            runId: data.runId,
            workspace: data.workspace,
            skillId: data.skillId,
            skillVersion: data.skillVersion,
            triggerType: data.triggerType ?? "manual",
            triggerPayload: data.triggerPayload,
            parentRunId: data.parentRunId,
            depth: data.depth,
          });
        } catch (err) {
          const pgErr = err as { code?: string };
          if (pgErr.code !== "23505") throw err;
        }
      }

      await runSkillStep({
        workspace: data.workspace,
        runId: data.runId,
        skillId: data.skillId,
        skillVersion: data.skillVersion,
        stepId: data.stepId,
        resumedWith: data.resumedWith,
      });
    },
    {
      ...getRedisConnectionOpts(),
      concurrency,
      limiter: {
        max: concurrency,
        duration: 1000,
      },
    },
  );

  _worker.on("completed", async (job: Job<SkillJobData>) => {
    await appendWal({
      workspace: job.data.workspace ?? workspaceId,
      op: "job_completed",
      actor: "bullmq-worker",
      payload: {
        job_id: job.id,
        run_id: job.data.runId,
        step_id: job.data.stepId,
        skill_id: job.data.skillId,
        duration_ms: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
      },
    });
  });

  _worker.on("failed", async (job: Job<SkillJobData> | undefined, err: Error) => {
    if (!job) return;

    await appendWal({
      workspace: job.data.workspace ?? workspaceId,
      op: "job_failed",
      actor: "bullmq-worker",
      payload: {
        job_id: job.id,
        run_id: job.data.runId,
        step_id: job.data.stepId,
        skill_id: job.data.skillId,
        error: err.message,
        attempt: job.attemptsMade,
      },
    });
  });

  // Graceful shutdown — give active jobs up to SHUTDOWN_DRAIN_MS to
  // complete so their status transitions fire and BullMQ locks release
  // cleanly. After that, force-close so systemd's TimeoutStopSec doesn't
  // SIGKILL the process mid-shutdown.
  const SHUTDOWN_DRAIN_MS = 25_000;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[nexaas] ${signal} received — draining BullMQ worker (max ${SHUTDOWN_DRAIN_MS / 1000}s)`);
    stopHeartbeatLoop();
    if (_worker) {
      const worker = _worker;
      _worker = null;
      try {
        await Promise.race([
          worker.close(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("drain timeout")), SHUTDOWN_DRAIN_MS),
          ),
        ]);
        console.log(`[nexaas] BullMQ worker closed cleanly`);
      } catch (err) {
        console.warn(
          `[nexaas] drain exceeded ${SHUTDOWN_DRAIN_MS / 1000}s — force-closing: ${(err as Error).message}`,
        );
        try { await worker.close(true); } catch { /* already forced */ }
      }
    }
    // Sweep in-flight skill_runs that didn't finish during drain (#86 Gap 3).
    // Worker SIGTERM (status=143, OOM-adjacent kills) used to lose jobs that
    // were `active` at exit time — they vanished from every BullMQ queue
    // without `markStepFailed` ever firing, so silent-failure-watchdog (#69)
    // never saw the streak. This sweep closes the loop: any skill_run still
    // at status='running' for this workspace gets stamped failed before
    // process.exit. Idempotent — if BullMQ later recovers the job, the
    // normal markCompleted path overwrites this stamp with status='completed'.
    try {
      await sweepInFlightRuns(workspaceId, signal);
    } catch (err) {
      console.warn(`[nexaas] in-flight sweep error: ${(err as Error).message}`);
    }
    // Tear down any pooled MCP subprocesses (#63). No-op when pooling is
    // disabled. Best-effort so shutdown never hangs on a misbehaving child.
    try { await shutdownMcpPool(); } catch (err) {
      console.warn(`[nexaas] MCP pool shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  return _worker;
}

export function getWorker(): Worker | null {
  return _worker;
}

/**
 * Phantom-skill terminal drawer (#172). Fired when a job arrives carrying
 * a manifestPath that no longer exists on disk — register-skill may have
 * persisted an ephemeral path that got cleaned up, or the workspace moved
 * the file without re-registering.
 *
 * Synthesizes a complete failure trail so downstream watchers don't have
 * to special-case "scheduler tick with no run":
 *   1. skill_run row created + marked failed (silent-failure-watchdog #69
 *      counts toward its streak)
 *   2. Terminal drawer written to a sensible default room — operators
 *      reading the dashboard see the failure with the missing path and
 *      a hint when the path was ephemeral
 *   3. WAL entry tagged `skill_manifest_missing`
 *
 * Each step is wrapped in its own try/catch — we want maximum signal even
 * if one writer is broken (e.g. DB lost). The caller throws afterward so
 * BullMQ marks the job failed and stops retrying.
 */
async function handleManifestMissing(
  data: SkillJobData,
  manifestPath: string,
): Promise<void> {
  const workspace = data.workspace;
  const runId = data.runId ?? randomUUID();
  const skillId = data.skillId ?? "unknown";
  const stepId = data.stepId ?? "fire";
  const ephemeral = isEphemeralPath(manifestPath);

  // 1. Skill run row + marked failed. Wrapped because the workspace may
  // have a stale schema or DB connection issue we don't want to mask
  // the drawer write.
  try {
    await runTracker.createRun({
      runId,
      workspace,
      skillId,
      skillVersion: data.skillVersion,
      triggerType: data.triggerType ?? "cron",
      triggerPayload: data.triggerPayload as Record<string, unknown> | undefined,
    });
  } catch (err) {
    const pgErr = err as { code?: string };
    // 23505 duplicate PK is fine — another path created the row already.
    if (pgErr.code !== "23505") {
      console.warn(`[nexaas] manifest_missing: createRun failed for ${skillId}: ${(err as Error).message}`);
    }
  }
  try {
    await runTracker.markStepFailed(runId, stepId, `manifest_missing: ${manifestPath}`);
  } catch (err) {
    console.warn(`[nexaas] manifest_missing: markStepFailed failed for ${skillId}: ${(err as Error).message}`);
  }

  // 2. Terminal drawer. Default room is `ops.scheduler.<skillId>` — the
  // skill's declared primary room is unknowable without the manifest, and
  // ops.scheduler is where phantom-skill failures naturally belong.
  try {
    const session = palace.enter({ workspace, runId, skillId, stepId });
    await session.writeDrawer(
      { wing: "ops", hall: "scheduler", room: skillId.replace(/\//g, "-") },
      JSON.stringify(buildTerminalDrawerPayload(
        { skill: skillId, terminal_reason: "manifest_missing" },
        {
          manifest_path: manifestPath,
          was_ephemeral_path: ephemeral,
          trigger_type: data.triggerType ?? "cron",
        },
      )),
    );
  } catch (err) {
    console.error(`[nexaas] manifest_missing: drawer write failed for ${skillId}: ${(err as Error).message}`);
  }

  // 3. WAL entry. Best-effort like everything in this handler.
  try {
    await appendWal({
      workspace,
      op: "skill_manifest_missing",
      actor: "bullmq-worker",
      payload: {
        run_id: runId,
        skill_id: skillId,
        manifest_path: manifestPath,
        was_ephemeral_path: ephemeral,
      },
    });
  } catch (err) {
    console.warn(`[nexaas] manifest_missing: WAL append failed for ${skillId}: ${(err as Error).message}`);
  }

  console.error(
    `[nexaas] PHANTOM SKILL: '${skillId}' fired but manifest is gone at ${manifestPath}` +
      (ephemeral ? " (ephemeral path — register without --allow-ephemeral)" : ""),
  );
}

/**
 * On worker shutdown, mark every still-`running` skill_run for this workspace
 * as failed with `error_summary='worker-exit-during-execution'` (#86 Gap 3).
 *
 * Why this is needed: a SIGTERM during BullMQ's drain window can force-close
 * the worker before active jobs run their `markStepFailed` / `markCompleted`
 * path. Those rows then sit at status='running' forever, invisible to
 * `silent-failure-watchdog` (#69) which only counts `failed` runs toward
 * its streak. Without this sweep, an OOM-adjacent SIGTERM during a marketing
 * skill run can leave the skill silently broken — exactly the failure mode
 * documented in #86.
 *
 * Idempotency: BullMQ's stalled-job recovery will re-process killed jobs
 * when the worker comes back. The normal completion path calls
 * `markCompleted` which overwrites the stamp with `status='completed'`,
 * so a job that recovers cleanly leaves no trace of the temporary failure
 * stamp. A job that fails on retry stays `failed` (correct outcome).
 *
 * Single-worker scope: this sweeps all `running` rows for the workspace
 * unconditionally. The Phase-2 multi-worker world (#97) will need a
 * worker-id filter so concurrent workers don't trample each other's
 * in-flight runs.
 *
 * Exported for the regression test (#86 Gap 3 test); not part of the
 * runtime's public surface.
 */
export async function sweepInFlightRuns(
  workspace: string,
  signal: string,
): Promise<number> {
  const rows = await sql<{ run_id: string; current_step: string | null; skill_id: string }>(
    `SELECT run_id, current_step, skill_id
       FROM nexaas_memory.skill_runs
      WHERE workspace = $1 AND status = 'running'`,
    [workspace],
  );

  if (rows.length === 0) return 0;

  let marked = 0;
  for (const row of rows) {
    try {
      // markStepFailed bumps the silent-failure streak counter (#69) — so
      // a sudden burst of worker-exit-during-execution stamps will trip
      // the watchdog if the threshold says it should. That's the desired
      // tie-in with #86 Gap 1; without this we'd never count toward the
      // streak when the worker died mid-execution.
      await runTracker.markStepFailed(
        row.run_id,
        row.current_step ?? "unknown",
        "worker-exit-during-execution",
      );
      marked++;
    } catch (err) {
      console.warn(
        `[nexaas] sweep: failed to mark run ${row.run_id} (${row.skill_id}): ${(err as Error).message}`,
      );
    }
  }

  console.log(`[nexaas] Shutdown sweep (${signal}): marked ${marked}/${rows.length} in-flight run(s) as failed`);
  try {
    await appendWal({
      workspace,
      op: "worker_shutdown_sweep",
      actor: "bullmq-worker",
      payload: { signal, total: rows.length, marked, failures: rows.length - marked },
    });
  } catch { /* WAL is observability; never let it block shutdown */ }

  return marked;
}
