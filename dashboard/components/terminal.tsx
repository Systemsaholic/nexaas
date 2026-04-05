"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface TerminalProps {
  target: string;
  className?: string;
}

export function Terminal({ target, className }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const initDone = useRef(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;

    // Close existing connection
    wsRef.current?.close();
    setStatus("connecting");
    term.write(`\r\nConnecting to ${target}...\r\n`);

    let token = "";
    try {
      const tokenRes = await fetch("/api/v1/terminal/token");
      const tokenJson = await tokenRes.json();
      token = tokenJson.data?.token ?? "";
    } catch {
      term.write("\x1b[31mFailed to get terminal token\x1b[0m\r\n");
      setStatus("disconnected");
      return;
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = window.location.hostname;
    const wsUrl = `${wsProtocol}//${wsHost}:3002?token=${encodeURIComponent(token)}&target=${encodeURIComponent(target)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write(`\r\n\x1b[90m[Session ended with code ${msg.data}]\x1b[0m\r\n`);
          setStatus("disconnected");
        } else if (msg.type === "error") {
          term.write(`\r\n\x1b[31m[Error: ${msg.data}]\x1b[0m\r\n`);
          setStatus("disconnected");
        }
      } catch {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      setStatus("disconnected");
      term.write("\r\n\x1b[31m[WebSocket error — is the terminal server running on port 3002?]\x1b[0m\r\n");
    };
  }, [target]);

  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    async function init() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      await import("@xterm/xterm/css/xterm.css");

      if (!containerRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Geist Mono', 'Fira Code', monospace",
        scrollback: 10000,
        theme: {
          background: "#09090b",
          foreground: "#fafafa",
          cursor: "#fafafa",
          selectionBackground: "#3f3f46",
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      fitAddon.fit();
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Forward input to active WebSocket
      term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
      resizeObserver.observe(containerRef.current);

      // Initial connection
      connect();
    }

    init();

    return () => {
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [connect]);

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {target === "orchestrator" ? "Orchestrator Terminal" : `Terminal: ${target}`}
          </span>
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            status === "connected" ? "bg-green-100 text-green-700" :
            status === "connecting" ? "bg-yellow-100 text-yellow-700" :
            "bg-red-100 text-red-700"
          }`}>{status}</span>
        </div>
        {status === "disconnected" && (
          <button
            onClick={connect}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Reconnect
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        className="rounded-md border bg-[#09090b] p-1"
        style={{ height: "500px" }}
      />
    </div>
  );
}
