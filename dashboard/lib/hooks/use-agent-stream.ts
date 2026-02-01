"use client";

import { useState, useRef, useCallback } from "react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

export type StreamStatus = "idle" | "connecting" | "streaming" | "done" | "error";

interface UseAgentStreamReturn {
  response: string;
  status: StreamStatus;
  error: string | null;
  fire: (agent: string, prompt: string) => void;
  cancel: () => void;
}

const WS_TIMEOUT_MS = 5_000;

/**
 * Shared hook for streaming agent responses via WebSocket.
 * If the gateway is unreachable or the connection fails, an error is surfaced.
 * No mock/simulated fallback — the user always sees real data or an error.
 */
export function useAgentStream(): UseAgentStreamReturn {
  const [response, setResponse] = useState("");
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const cancelledRef = useRef(false);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const gateways = useWorkspaceStore((s) => s.gateways);

  const cleanup = useCallback(() => {
    cancelledRef.current = true;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const fire = useCallback(
    (agent: string, prompt: string) => {
      // Reset
      cleanup();
      cancelledRef.current = false;
      setResponse("");
      setError(null);
      setStatus("connecting");

      if (!activeWorkspaceId) {
        setStatus("error");
        setError("No active workspace. Connect to a gateway first.");
        return;
      }

      const gwConfig = gateways.get(activeWorkspaceId);
      if (!gwConfig) {
        setStatus("error");
        setError("Gateway configuration not found.");
        return;
      }

      const wsBase = gwConfig.url.replace(/^http/, "ws");

      const timeout = setTimeout(() => {
        if (!cancelledRef.current) {
          ws.close();
          setStatus("error");
          setError("Connection timed out — the gateway may be offline.");
        }
      }, WS_TIMEOUT_MS);

      const ws = new WebSocket(`${wsBase}/api/chat`, [`token.${gwConfig.apiKey}`]);
      wsRef.current = ws;

      ws.onopen = () => {
        clearTimeout(timeout);
        if (cancelledRef.current) { ws.close(); return; }
        setStatus("streaming");
        ws.send(JSON.stringify({ agent, message: prompt }));
      };

      ws.onmessage = (ev) => {
        if (cancelledRef.current) return;
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "chunk") {
            setResponse((prev) => prev + data.content);
          } else if (data.type === "done") {
            setStatus("done");
            ws.close();
          } else if (data.type === "error") {
            setStatus("error");
            setError(data.content || "Agent returned an error.");
            ws.close();
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        if (!cancelledRef.current) {
          setStatus("error");
          setError("Could not connect to the gateway. Check that the backend is running.");
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        wsRef.current = null;
      };
    },
    [activeWorkspaceId, gateways, cleanup],
  );

  const cancel = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  return { response, status, error, fire, cancel };
}
