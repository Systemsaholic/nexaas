"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

interface QueueJob {
  id: number;
  event_id: string | null;
  action_type: string;
  status: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

interface QueueData {
  counts: { queued: number; running: number; completed: number; failed: number };
  recent: QueueJob[];
}

interface QueueStatusConfig {
  show_workers?: boolean;
  show_history?: boolean;
  [key: string]: unknown;
}

const jobBadge: Record<string, string> = {
  queued: "bg-zinc-500/15 text-zinc-600",
  running: "bg-blue-500/15 text-blue-700",
  completed: "bg-emerald-500/15 text-emerald-700",
  failed: "bg-red-500/15 text-red-700",
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

export default function QueueStatus({
  config,
  title,
}: {
  config: QueueStatusConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getQueueStatus()
      .then((d) => {
        if (!cancelled) setData(d as unknown as QueueData);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

  const counts = data?.counts ?? { queued: 0, running: 0, completed: 0, failed: 0 };
  const jobs = data?.recent ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Queue Status"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-4 gap-3">
          {(["queued", "running", "completed", "failed"] as const).map((s) => (
            <div key={s} className="rounded-lg border p-3 text-center">
              <div className="text-xl font-bold">
                {loading ? <Skeleton className="mx-auto h-7 w-8" /> : counts[s]}
              </div>
              <div className="text-xs capitalize text-muted-foreground">{s}</div>
            </div>
          ))}
        </div>
        <Separator />
        <ScrollArea className="h-[200px]">
          <div className="flex flex-col gap-2">
            {loading
              ? [1, 2, 3].map((n) => <Skeleton key={n} className="h-12 w-full" />)
              : jobs.map((job) => (
                  <div
                    key={job.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{job.action_type}</span>
                      <span className="text-xs text-muted-foreground">
                        #{job.id} &middot; {timeAgo(job.queued_at)}
                        {job.error && (
                          <span className="ml-1 text-red-600"> — {job.error}</span>
                        )}
                      </span>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`text-[10px] ${jobBadge[job.status] ?? ""}`}
                    >
                      {job.status}
                    </Badge>
                  </div>
                ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
