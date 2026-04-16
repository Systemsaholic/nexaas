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

import { execSync } from "child_process";
import { palace, appendWal } from "@nexaas/palace";
import { runTracker } from "./run-tracker.js";
import { randomUUID } from "crypto";

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

    const stdout = execSync(manifest.execution.command, {
      encoding: "utf-8",
      timeout: timeoutMs,
      cwd: manifest.execution.working_directory,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NEXAAS_RUN_ID: runId },
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
    const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };

    const room = manifest.rooms?.primary ?? { wing: "operations", hall: "shell", room: manifest.id };
    await session.writeDrawer(room, JSON.stringify({
      skill: manifest.id,
      command: manifest.execution.command,
      success: false,
      exit_code: execErr.status ?? 1,
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
        exit_code: execErr.status ?? 1,
        duration_ms: durationMs,
        error: (execErr.stderr ?? execErr.message ?? "").slice(0, 500),
      },
    });

    await runTracker.markStepFailed(runId, stepId, err);

    return {
      success: false,
      exitCode: execErr.status ?? 1,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? execErr.message ?? "",
      durationMs,
    };
  }
}
