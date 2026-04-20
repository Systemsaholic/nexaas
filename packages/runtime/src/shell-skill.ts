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

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { palace, appendWal } from "@nexaas/palace";
import { runTracker } from "./run-tracker.js";
import { randomUUID } from "crypto";

// Async exec so shell skills don't block the Node event loop — with
// execSync, every shell-skill run (up to 120s per the default timeout)
// froze the HTTP server, BullMQ heartbeat, and every other consumer of
// the main thread. See #33.
const execAsync = promisify(execCb);

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
}

export async function runShellSkill(
  workspace: string,
  manifest: ShellSkillManifest,
): Promise<{ success: boolean; exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const runId = randomUUID();
  const stepId = "shell-exec";

  await runTracker.createRun({
    runId,
    workspace,
    skillId: manifest.id,
    skillVersion: manifest.version,
    triggerType: "cron",
  });

  await runTracker.markStepStarted(runId, stepId);

  const session = palace.enter({ workspace, runId, skillId: manifest.id, stepId });
  const startTime = Date.now();

  try {
    const timeoutMs = (manifest.execution.timeout ?? 120) * 1000;

    const { stdout } = await execAsync(manifest.execution.command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      cwd: manifest.execution.working_directory,
      env: { ...process.env, NEXAAS_RUN_ID: runId },
      // Bounded buffer so a runaway skill can't balloon memory inside
      // the worker process. 10 MB is generous for shell output; skills
      // producing more should write to a file and record a path.
      maxBuffer: 10 * 1024 * 1024,
    });

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
