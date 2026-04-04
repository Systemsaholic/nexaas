import { execFile } from "node:child_process";
import type { WorkspaceManifest } from "./types";

interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function sshExec(
  manifest: WorkspaceManifest,
  command: string,
  timeoutMs = 15000
): Promise<SshResult> {
  const { host, user, port } = manifest.ssh;

  return new Promise((resolve) => {
    const proc = execFile(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
        "-p", String(port),
        `${user}@${host}`,
        command,
      ],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
        });
      }
    );

    proc.on("error", () => {
      resolve({ stdout: "", stderr: "SSH connection failed", exitCode: 255 });
    });
  });
}

export async function collectVpsHealth(manifest: WorkspaceManifest) {
  const cmds = [
    "free -m | awk '/^Mem:/ {print $2,$3}'",
    "df -BG / | awk 'NR==2 {print $2,$3}'",
    "docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null || echo 'no-docker'",
    "systemctl is-active nexaas-worker 2>/dev/null || echo 'inactive'",
  ].join(" && echo '---' && ");

  const result = await sshExec(manifest, cmds);
  if (result.exitCode !== 0) {
    return null;
  }

  const sections = result.stdout.split("---").map((s) => s.trim());
  const [ramTotal, ramUsed] = (sections[0] ?? "0 0").split(/\s+/).map(Number);
  const diskParts = (sections[1] ?? "0G 0G").replace(/G/g, "").split(/\s+/).map(Number);
  const containerLines = (sections[2] ?? "").split("\n").filter((l) => l && l !== "no-docker");
  const healthyContainers = containerLines.filter(
    (l) => l.includes("Up") && !l.includes("(unhealthy)")
  ).length;
  const workerActive = (sections[3] ?? "inactive").trim() === "active";

  return {
    ram_total_mb: ramTotal || 0,
    ram_used_mb: ramUsed || 0,
    disk_total_gb: diskParts[0] || 0,
    disk_used_gb: diskParts[1] || 0,
    container_count: containerLines.length,
    containers_healthy: healthyContainers,
    worker_active: workerActive,
    vps_ip: manifest.network.privateIp,
  };
}
