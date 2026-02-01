"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircleIcon } from "lucide-react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

interface EventItem {
  id: string;
  description: string;
  status: string;
  agent: string;
  action_type: string;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
}

interface EventTimelineConfig {
  filters?: string[];
  limit?: number;
  [key: string]: unknown;
}

function statusCategory(status: string): string {
  if (status === "active") return "success";
  if (status === "failed") return "error";
  if (status === "paused" || status === "expired") return "pending";
  return "info";
}

const statusColors: Record<string, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  pending: "bg-yellow-500",
  info: "bg-blue-500",
};

const badgeColors: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-700",
  error: "bg-red-500/15 text-red-700",
  pending: "bg-yellow-500/15 text-yellow-700",
  info: "bg-blue-500/15 text-blue-700",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function EventTimeline({
  config,
  title,
}: {
  config: EventTimelineConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveGatewayClient());
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getEvents({ limit: config.limit ?? 20 })
      .then((data) => {
        if (!cancelled) setEvents(data as unknown as EventItem[]);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load events");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, config.limit]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Event Timeline"}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {fetchError ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <AlertCircleIcon className="size-8 text-destructive" />
            <p className="text-sm text-destructive">{fetchError}</p>
          </div>
        ) : (
        <ScrollArea className="h-[350px] px-4 pb-4">
          <div className="relative ml-3 border-l border-border pl-6">
            {loading && (
              <div className="flex flex-col gap-4 py-2">
                {[1, 2, 3].map((n) => (
                  <Skeleton key={n} className="h-10 w-full" />
                ))}
              </div>
            )}
            {!loading &&
              events.map((event) => {
                const cat = statusCategory(event.status);
                return (
                  <div key={event.id} className="relative pb-6 last:pb-0">
                    <span
                      className={`absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-background ${statusColors[cat]}`}
                    />
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className={`text-[10px] ${badgeColors[cat]}`}>
                          {event.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {event.agent ?? "system"}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {timeAgo(event.last_run_at ?? event.created_at)}
                        </span>
                      </div>
                      <p className="text-sm">{event.description ?? event.action_type}</p>
                      {event.run_count > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {event.run_count} runs
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            {!loading && events.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">No events.</p>
            )}
          </div>
        </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
