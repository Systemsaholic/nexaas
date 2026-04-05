/**
 * WebSocket terminal server with persistent sessions.
 *
 * Orchestrator sessions persist when the browser navigates away.
 * Instance sessions (Claude Code) are ephemeral — killed on disconnect.
 *
 * Persistent sessions keep a scrollback buffer so reconnecting clients
 * see what happened while they were away.
 */

import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac } from "crypto";

const PORT = parseInt(process.env.TERMINAL_PORT ?? "3002", 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const NEXAAS_ROOT = process.env.NEXAAS_ROOT ?? "/opt/nexaas";
const SCROLLBACK_LIMIT = 100000; // characters to keep in buffer

interface WorkspaceManifest {
  ssh: { host: string; user: string; port: number };
}

interface PersistentSession {
  term: pty.IPty;
  target: string;
  scrollback: string;
  clients: Set<WebSocket>;
  alive: boolean;
}

// Persistent sessions keyed by target name
const sessions = new Map<string, PersistentSession>();

function loadManifest(workspaceId: string): WorkspaceManifest | null {
  try {
    const raw = readFileSync(join(NEXAAS_ROOT, "workspaces", `${workspaceId}.workspace.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getOrCreateSession(target: string): PersistentSession | null {
  // Only orchestrator sessions are persistent
  if (target !== "orchestrator") return null;

  const existing = sessions.get(target);
  if (existing?.alive) return existing;

  // Clean up dead session
  if (existing) sessions.delete(target);

  const term = pty.spawn("/bin/bash", ["--login"], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: NEXAAS_ROOT,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  const session: PersistentSession = {
    term,
    target,
    scrollback: "",
    clients: new Set(),
    alive: true,
  };

  // Capture all output to scrollback + broadcast to connected clients
  term.onData((data: string) => {
    // Append to scrollback
    session.scrollback += data;
    if (session.scrollback.length > SCROLLBACK_LIMIT) {
      session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT);
    }

    // Broadcast to all connected clients
    const msg = JSON.stringify({ type: "output", data });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`Persistent session ended: target=${target}, exitCode=${exitCode}`);
    session.alive = false;

    const msg = JSON.stringify({ type: "exit", data: exitCode });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
        client.close();
      }
    }
    sessions.delete(target);
  });

  sessions.set(target, session);
  console.log(`Persistent session created: target=${target}, pid=${term.pid}`);
  return session;
}

const wss = new WebSocketServer({ port: PORT });
console.log(`Terminal WebSocket server listening on port ${PORT}`);

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const token = url.searchParams.get("token");
  const target = url.searchParams.get("target") ?? "orchestrator";

  // Auth check
  // Validate HMAC token (format: timestamp:hmac)
  const isValidToken = (() => {
    if (!token || !ADMIN_SECRET) return false;
    // Also accept raw secret for backward compatibility
    if (token === ADMIN_SECRET) return true;
    const parts = token.split(":");
    if (parts.length !== 2) return false;
    const [ts, hmac] = parts;
    const timestamp = parseInt(ts, 10);
    // Token valid for 5 minutes
    if (Date.now() - timestamp > 5 * 60 * 1000) return false;
    const expected = createHmac("sha256", ADMIN_SECRET).update(`terminal:${ts}`).digest("hex");
    return hmac === expected;
  })();

  if (!isValidToken) {
    ws.send(JSON.stringify({ type: "error", data: "Unauthorized" }));
    ws.close(1008, "Unauthorized");
    return;
  }

  // Try persistent session (orchestrator only)
  const persistent = getOrCreateSession(target);

  if (persistent) {
    // Attach to persistent session
    persistent.clients.add(ws);
    console.log(`Client attached to persistent session: target=${target}, clients=${persistent.clients.size}`);

    // Send scrollback so client sees history
    if (persistent.scrollback.length > 0) {
      ws.send(JSON.stringify({ type: "output", data: persistent.scrollback }));
    }

    // Client input → PTY
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") {
          persistent.term.write(msg.data);
        } else if (msg.type === "resize") {
          persistent.term.resize(msg.cols, msg.rows);
        }
      } catch {
        persistent.term.write(raw.toString());
      }
    });

    // Client disconnect — detach but keep session alive
    ws.on("close", () => {
      persistent.clients.delete(ws);
      console.log(`Client detached from persistent session: target=${target}, clients=${persistent.clients.size}`);
    });

    ws.on("error", () => {
      persistent.clients.delete(ws);
    });

    return;
  }

  // Ephemeral session (instance Claude Code)
  const manifest = loadManifest(target);
  if (!manifest?.ssh) {
    ws.send(JSON.stringify({ type: "error", data: `Unknown target: ${target}` }));
    ws.close(1008, "Unknown target");
    return;
  }

  const term = pty.spawn("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-p", String(manifest.ssh.port),
    "-t",
    `${manifest.ssh.user}@${manifest.ssh.host}`,
    "cd /opt/nexaas && exec claude --dangerously-skip-permissions",
  ], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  console.log(`Ephemeral session opened: target=${target}, pid=${term.pid}`);

  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  term.onExit(({ exitCode }) => {
    console.log(`Ephemeral session closed: target=${target}, exitCode=${exitCode}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", data: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        term.resize(msg.cols, msg.rows);
      }
    } catch {
      term.write(raw.toString());
    }
  });

  ws.on("close", () => {
    console.log(`Ephemeral WebSocket closed: target=${target}`);
    term.kill();
  });

  ws.on("error", (err) => {
    console.error(`Ephemeral WebSocket error: ${err.message}`);
    term.kill();
  });
});
