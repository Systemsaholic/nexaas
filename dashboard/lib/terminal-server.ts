/**
 * WebSocket terminal server.
 * Runs as a separate process alongside the Next.js dashboard.
 * Spawns SSH sessions (or local bash) and streams I/O via WebSocket.
 */

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.TERMINAL_PORT ?? "3002", 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";

interface WorkspaceManifest {
  ssh: { host: string; user: string; port: number };
}

function loadManifest(workspaceId: string): WorkspaceManifest | null {
  try {
    const raw = readFileSync(join(NEXAAS_ROOT, "workspaces", `${workspaceId}.workspace.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const wss = new WebSocketServer({ port: PORT });

console.log(`Terminal WebSocket server listening on port ${PORT}`);

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const token = url.searchParams.get("token");
  const target = url.searchParams.get("target") ?? "orchestrator";

  // Auth check
  if (token !== ADMIN_SECRET) {
    ws.send(JSON.stringify({ type: "error", data: "Unauthorized" }));
    ws.close(1008, "Unauthorized");
    return;
  }

  // Determine shell command
  let shell: string;
  let args: string[];

  if (target === "orchestrator") {
    shell = "/bin/bash";
    args = ["--login"];
  } else {
    const manifest = loadManifest(target);
    if (!manifest?.ssh) {
      ws.send(JSON.stringify({ type: "error", data: `Unknown target: ${target}` }));
      ws.close(1008, "Unknown target");
      return;
    }
    shell = "ssh";
    args = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=30",
      "-p", String(manifest.ssh.port),
      "-t",
      `${manifest.ssh.user}@${manifest.ssh.host}`,
      "--", "claude", "--dangerously-skip-permissions",
    ];
  }

  // Spawn PTY
  const term = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: target === "orchestrator" ? NEXAAS_ROOT : undefined,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  console.log(`Terminal opened: target=${target}, pid=${term.pid}`);

  // PTY → WebSocket
  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`Terminal closed: target=${target}, exitCode=${exitCode}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", data: exitCode }));
      ws.close();
    }
  });

  // WebSocket → PTY
  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        term.resize(msg.cols, msg.rows);
      }
    } catch {
      // Raw text fallback
      term.write(raw.toString());
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket closed: target=${target}`);
    term.kill();
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message}`);
    term.kill();
  });
});
