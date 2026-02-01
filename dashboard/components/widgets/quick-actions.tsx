"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { renderMarkdown } from "@/lib/sanitize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

interface ActionButton {
  label: string;
  icon: string;
  agent: string;
  prompt: string;
  variant?: string;
}

interface QuickActionsConfig {
  actions?: ActionButton[];
  [key: string]: unknown;
}

interface ActionLog {
  label: string;
  agent: string;
  status: "sending" | "streaming" | "done" | "error";
  response: string;
  timestamp: Date;
}

export default function QuickActions({
  config,
  title,
}: {
  config: QuickActionsConfig;
  title?: string;
}) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const gateways = useWorkspaceStore((s) => s.gateways);
  const [logs, setLogs] = useState<ActionLog[]>([]);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const actions = config.actions ?? [];

  const runAction = useCallback(
    (action: ActionButton) => {
      if (!activeWorkspaceId) return;
      const gwConfig = gateways.get(activeWorkspaceId);
      if (!gwConfig) return;

      setRunningAction(action.label);
      const log: ActionLog = {
        label: action.label,
        agent: action.agent,
        status: "sending",
        response: "",
        timestamp: new Date(),
      };
      setLogs((prev) => [log, ...prev].slice(0, 10));

      const wsBase = gwConfig.url.replace(/^http/, "ws");
      const ws = new WebSocket(
        `${wsBase}/api/chat`,
        [`token.${gwConfig.apiKey}`]
      );

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            agent: action.agent,
            message: action.prompt,
          })
        );
        setLogs((prev) =>
          prev.map((l) =>
            l === log ? { ...l, status: "streaming" } : l
          )
        );
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === "chunk") {
            setLogs((prev) =>
              prev.map((l) =>
                l.timestamp === log.timestamp
                  ? { ...l, response: l.response + data.content }
                  : l
              )
            );
          } else if (data.type === "done") {
            setLogs((prev) =>
              prev.map((l) =>
                l.timestamp === log.timestamp ? { ...l, status: "done" } : l
              )
            );
            setRunningAction(null);
            ws.close();
          } else if (data.type === "error") {
            setLogs((prev) =>
              prev.map((l) =>
                l.timestamp === log.timestamp
                  ? { ...l, status: "error", response: data.content }
                  : l
              )
            );
            setRunningAction(null);
            ws.close();
          }
        } catch {
          // ignore malformed WS messages
        }
      };

      ws.onerror = () => {
        setLogs((prev) =>
          prev.map((l) =>
            l.timestamp === log.timestamp
              ? { ...l, status: "error", response: "Connection failed" }
              : l
          )
        );
        setRunningAction(null);
      };

      wsRef.current = ws;
    },
    [activeWorkspaceId, gateways]
  );

  useEffect(() => {
    return () => { wsRef.current?.close(); };
  }, []);

  const statusBadge: Record<string, string> = {
    sending: "bg-yellow-500/15 text-yellow-700",
    streaming: "bg-blue-500/15 text-blue-700 animate-pulse",
    done: "bg-emerald-500/15 text-emerald-700",
    error: "bg-red-500/15 text-red-700",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {title ?? "Quick Actions"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Action buttons grid */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
          {actions.map((action, i) => (
            <Button
              key={i}
              variant={
                (action.variant as "default" | "outline" | "secondary") ??
                "outline"
              }
              size="sm"
              className="h-auto flex-col gap-1 py-3 text-xs"
              disabled={runningAction !== null}
              onClick={() => runAction(action)}
            >
              <span className="text-lg">{action.icon}</span>
              <span className="font-medium">{action.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {action.agent}
              </span>
            </Button>
          ))}
        </div>

        {/* Action log */}
        {logs.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              Recent Actions
            </span>
            <ScrollArea className="h-[200px]">
              <div className="flex flex-col gap-2">
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className="rounded-md border px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">
                        {log.label}
                      </span>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] ${statusBadge[log.status] ?? ""}`}
                      >
                        {log.status}
                      </Badge>
                    </div>
                    {log.response && (
                      <div
                        className="prose prose-sm dark:prose-invert mt-1 max-h-20 overflow-hidden text-xs text-muted-foreground"
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(log.response.slice(0, 300) + (log.response.length > 300 ? "…" : "")),
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
