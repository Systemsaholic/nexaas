/**
 * Shell command execution helper for Trigger.dev tasks.
 *
 * Runs shell commands as subprocesses, streams output to Trigger.dev logger,
 * and returns structured results. Used for Python scripts and cron wrappers
 * that don't need Claude Code.
 */

import { spawn } from "child_process";
import { logger } from "@trigger.dev/sdk/v3";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ShellOptions {
  /** Command to run (passed to /bin/bash -c) */
  command: string;
  /** Working directory (defaults to workspace root) */
  cwd?: string;
  /** Timeout in ms (default: 10 minutes) */
  timeoutMs?: number;
  /** Extra environment variables */
  env?: Record<string, string>;
}

export interface ShellResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || process.env.NEXAAS_ROOT || "/opt/nexaas";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Main runner ─────────────────────────────────────────────────────────────

export async function runShell(options: ShellOptions): Promise<ShellResult> {
  const startTime = Date.now();
  const cwd = options.cwd || DEFAULT_WORKSPACE_ROOT;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  logger.info(`Running shell command`, {
    command: options.command,
    cwd,
    timeoutMs,
  });

  return new Promise<ShellResult>((resolve) => {
    const proc = spawn("/bin/bash", ["-c", options.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      detached: true, // New process group so we can kill the entire tree
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Stream to Trigger.dev logger line by line
      for (const line of text.split("\n").filter((l) => l.trim())) {
        logger.info(`[stdout] ${line}`);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      for (const line of text.split("\n").filter((l) => l.trim())) {
        logger.warn(`[stderr] ${line}`);
      }
    });

    // Kill entire process group (negative PID) to clean up subprocesses
    const killProcessGroup = (signal: NodeJS.Signals) => {
      try {
        if (proc.pid) process.kill(-proc.pid, signal);
      } catch {
        // Process group may already be gone
        try { proc.kill(signal); } catch { /* already dead */ }
      }
    };

    // Timeout guard — kills entire process tree, not just direct child
    const timer = setTimeout(() => {
      logger.error(`Command timed out after ${timeoutMs}ms, killing process group`);
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null) {
          logger.error("SIGTERM ignored, sending SIGKILL");
          killProcessGroup("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const success = code === 0;

      if (success) {
        logger.info(`Command completed successfully`, { durationMs });
      } else {
        logger.error(`Command failed with exit code ${code}`, {
          durationMs,
          stderr: stderr.slice(0, 1000),
        });
      }

      resolve({ success, exitCode: code, stdout, stderr, durationMs });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      logger.error(`Failed to spawn command: ${err.message}`);
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr: err.message,
        durationMs,
      });
    });
  });
}
