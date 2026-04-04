"use client";

import { useEffect, useRef, useState } from "react";

interface TerminalProps {
  target: string;
  className?: string;
}

export function Terminal({ target, className }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<any>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    let disposed = false;

    async function init() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Geist Mono', 'Fira Code', monospace",
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

      // Get terminal token from authenticated API
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

      term.write(`Connecting to ${target}...\r\n`);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) {
          setStatus("connected");
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
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
        if (!disposed) {
          setStatus("disconnected");
          term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
        }
      };

      ws.onerror = () => {
        if (!disposed) {
          setStatus("disconnected");
          term.write("\r\n\x1b[31m[WebSocket error — is the terminal server running on port 3002?]\x1b[0m\r\n");
        }
      };

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      });
      resizeObserver.observe(containerRef.current);

      return () => resizeObserver.disconnect();
    }

    init();

    return () => {
      disposed = true;
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [target]);

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
      </div>
      <div
        ref={containerRef}
        className="rounded-md border bg-[#09090b] p-1"
        style={{ height: "500px" }}
      />
    </div>
  );
}
