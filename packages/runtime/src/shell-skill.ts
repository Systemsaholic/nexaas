/**
 * Shell skill executor — runs shell commands as Nexaas skills.
 *
 * For skills with `execution.type: shell` in their manifest.
 * These bypass the pillar pipeline (no CAG/RAG/Model/TAG) and
 * just execute a command, record the result as a palace drawer,
 * and log to the WAL.
 *
 * Used for migrating simple cron jobs and shell-based automations
 * that don't need AI processing.
 */

import { spawn } from "child_process";
import { palace, appendWal } from "@nexaas/palace";
import { runTracker } from "./run-tracker.js";
import { randomUUID } from "crypto";

interface ShellRunResult {
  stdout: string;
  stderr: string;
}

interface ShellRunError extends Error {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

/**
 * Run a shell command in its own process group so a timeout can SIGKILL
 * every descendant — including grandchildren that ignore SIGTERM (e.g. a
 * Python interpreter blocked inside Playwright's Chromium IPC). See #109.
 *
 * Node's `child_process.exec({ timeout })` only signals the immediate
 * child (the `/bin/sh -c` shell). If a grandchild is wedged in C-level
 * blocking I/O, the SIGTERM never lands and the subprocess tree orphans.
 * Phoenix saw 54 leaked Playwright processes accumulate over 8 days
 * (~8 GB RAM, ~4 GB swap) before the silent-failure watchdog noticed.
 *
 * Fix: spawn with `detached: true` (own process group) and on timeout
 * SIGKILL the *negative pid* — kernel delivers to every process in the
 * group regardless of cooperation. SIGTERM-with-grace is sent first so
 * well-behaved scripts get to flush; SIGKILL follows after `gracePeriod`.
 */
function runShellWithGroupTimeout(
  command: string,
  opts: { cwd?: string; env: NodeJS.ProcessEnv; maxBuffer: number },
  timeoutMs: number,
): Promise<ShellRunResult> {
  const gracePeriodMs = 2000;
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdout.length + chunk.length > opts.maxBuffer) {
        stdout += chunk.toString("utf-8").slice(0, opts.maxBuffer - stdout.length);
        stdoutTruncated = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      } else {
        stdout += chunk.toString("utf-8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      if (stderr.length + chunk.length > opts.maxBuffer) {
        stderr += chunk.toString("utf-8").slice(0, opts.maxBuffer - stderr.length);
        stderrTruncated = true;
      } else {
        stderr += chunk.toString("utf-8");
      }
    });

    const sigtermTimer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    }, timeoutMs);

    const sigkillTimer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs + gracePeriodMs);

    child.on("close", (code, signal) => {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
      } else {
        const err: ShellRunError = Object.assign(
          new Error(timedOut ? `command timed out after ${timeoutMs}ms` : `non-zero exit code ${code}`),
          { code, signal, stdout, stderr, killed: timedOut },
        );
        reject(err);
      }
    });
    child.on("error", (err) => {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      reject(Object.assign(err as ShellRunError, { stdout, stderr }));
    });
  });
}

export interface ShellSkillManifest {
  id: string;
  version: string;
  description?: string;
  execution: {
    type: "shell";
    command: string;
    timeout?: number;
    working_directory?: string;
  };
  rooms?: {
    primary?: { wing: string; hall: string; room: string };
  };
  /**
   * Optional mutex groups. Skills declaring overlapping group names
   * serialize within the worker; non-overlapping skills parallelize.
   * See docs/rfcs/0001-skill-concurrency-groups.md.
   */
  concurrency_groups?: string[];
}

export interface SkillExecutionContext {
  runId?: string;
  stepId?: string;
  triggerType?: string;
  triggerPayload?: Record<string, unknown>;
}

export async function runShellSkill(
  workspace: string,
  manifest: ShellSkillManifest,
  context?: SkillExecutionContext,
): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  // Reuse the BullMQ job's runId / stepId / triggerType / triggerPayload
  // when dispatched via the inbound dispatcher or outbox relay so a
  // single logical skill invocation carries one run_id end-to-end (#47).
  // Falls back to a fresh id for direct callers (tests, one-off CLI).
  const runId = context?.runId ?? randomUUID();
  const stepId = context?.stepId ?? "shell-exec";
  const triggerType = context?.triggerType ?? "cron";
  const triggerPayload = context?.triggerPayload;

  // createRun is idempotent against duplicate PK (23505) — the dispatcher
  // does NOT create a skill_runs row, but a future producer might. Guard
  // rather than breaking downstream dispatches on a collision.
  try {
    await runTracker.createRun({
      runId,
      workspace,
      skillId: manifest.id,
      skillVersion: manifest.version,
      triggerType,
      triggerPayload,
    });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code !== "23505") throw err;
  }

  await runTracker.markStepStarted(runId, stepId);

  const session = palace.enter({ workspace, runId, skillId: manifest.id, stepId });
  const startTime = Date.now();

  try {
    const timeoutMs = (manifest.execution.timeout ?? 120) * 1000;

    const { stdout } = await runShellWithGroupTimeout(
      manifest.execution.command,
      {
        cwd: manifest.execution.working_directory,
        env: {
          ...process.env,
          // Prepend working_directory to PYTHONPATH so `python3 scripts/foo.py`
          // can import sibling packages of the repo root (#68). Python only
          // auto-adds cwd to sys.path in interactive/`-c` mode, not for script
          // invocations — without this, every ops script needs sys.path boilerplate.
          ...(manifest.execution.working_directory
            ? {
                PYTHONPATH: process.env.PYTHONPATH
                  ? `${manifest.execution.working_directory}:${process.env.PYTHONPATH}`
                  : manifest.execution.working_directory,
              }
            : {}),
          NEXAAS_RUN_ID: runId,
          NEXAAS_TRIGGER_TYPE: triggerType,
          // Payload as JSON so shell skills can parse without a DB round trip.
          // Empty string when no trigger payload — shell `test -n` semantics work.
          NEXAAS_TRIGGER_PAYLOAD: triggerPayload ? JSON.stringify(triggerPayload) : "",
        },
        // Bounded buffer so a runaway skill can't balloon memory inside
        // the worker process. 10 MB is generous for shell output; skills
        // producing more should write to a file and record a path.
        maxBuffer: 10 * 1024 * 1024,
      },
      timeoutMs,
    );

    const durationMs = Date.now() - startTime;

    // Write result drawer
    const room = manifest.rooms?.primary ?? { wing: "operations", hall: "shell", room: manifest.id };
    await session.writeDrawer(room, JSON.stringify({
      skill: manifest.id,
      command: manifest.execution.command,
      success: true,
      exit_code: 0,
      duration_ms: durationMs,
      stdout_preview: stdout.slice(0, 500),
    }));

    await appendWal({
      workspace,
      op: "shell_skill_completed",
      actor: `skill:${manifest.id}`,
      payload: {
        run_id: runId,
        command: manifest.execution.command,
        exit_code: 0,
        duration_ms: durationMs,
      },
    });

    await runTracker.markStepCompleted(runId, stepId);
    await runTracker.markCompleted(runId);

    return { success: true, exitCode: 0, stdout, stderr: "", durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    // Promisified `exec` throws an error with `code` (exit code), `signal`,
    // `stdout`, `stderr`, and `message`. Previous `execSync` used `status`
    // for the exit code — support both so we don't lose exit metadata.
    const execErr = err as {
      code?: number | string;
      status?: number;
      signal?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const exitCode = typeof execErr.code === "number"
      ? execErr.code
      : (execErr.status ?? 1);

    const room = manifest.rooms?.primary ?? { wing: "operations", hall: "shell", room: manifest.id };
    await session.writeDrawer(room, JSON.stringify({
      skill: manifest.id,
      command: manifest.execution.command,
      success: false,
      exit_code: exitCode,
      duration_ms: durationMs,
      stderr_preview: (execErr.stderr ?? execErr.message ?? "").slice(0, 500),
    }));

    await appendWal({
      workspace,
      op: "shell_skill_failed",
      actor: `skill:${manifest.id}`,
      payload: {
        run_id: runId,
        command: manifest.execution.command,
        exit_code: exitCode,
        duration_ms: durationMs,
        error: (execErr.stderr ?? execErr.message ?? "").slice(0, 500),
      },
    });

    await runTracker.markStepFailed(runId, stepId, err);

    return {
      success: false,
      exitCode,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? execErr.message ?? "",
      durationMs,
    };
  }
}
