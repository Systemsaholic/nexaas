"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DeployProgress } from "@/components/deploy-progress";
import { ArrowLeft, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { DeployRun } from "@/lib/types";

export default function DeployProgressPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<DeployRun | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchStatus() {
    try {
      const res = await fetch(`/api/v1/deploys/${runId}`);
      const json = await res.json();
      if (json.ok) setRun(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      fetchStatus();
    }, 3000);
    return () => clearInterval(interval);
  }, [runId]);

  // Stop polling when done
  useEffect(() => {
    if (run && (run.status === "completed" || run.status === "failed")) {
      // One final fetch to get complete logs
      fetchStatus();
    }
  }, [run?.status]);

  if (loading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!run) {
    return <p className="text-zinc-500">Deploy run not found.</p>;
  }

  const isActive = run.status === "pending" || run.status === "running";

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/deploy">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Deploy: {run.workspace_id}</h1>
          <p className="text-sm text-zinc-500">{run.vps_ip} — {run.admin_email}</p>
        </div>
        <StatusBadge status={run.status} />
      </div>

      {/* Status Banner */}
      {run.status === "completed" && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-4 text-green-700 dark:bg-green-950 dark:text-green-300">
          <CheckCircle2 className="h-5 w-5" />
          <span className="font-medium">Deployment completed successfully</span>
        </div>
      )}
      {run.status === "failed" && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-4 text-red-700 dark:bg-red-950 dark:text-red-300">
          <XCircle className="h-5 w-5" />
          <div>
            <span className="font-medium">Deployment failed</span>
            {run.error && <p className="text-sm mt-1">{run.error}</p>}
          </div>
        </div>
      )}
      {isActive && (
        <div className="flex items-center gap-2 rounded-md bg-blue-50 p-4 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="font-medium">Deployment in progress... (polling every 3s)</span>
        </div>
      )}

      {/* Steps */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployment Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <DeployProgress steps={run.steps} currentStep={run.current_step} />
        </CardContent>
      </Card>

      {/* Logs */}
      {run.log_output && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Deploy Log</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-80 rounded-md border bg-zinc-950 p-3">
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{run.log_output}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Post-deploy actions */}
      {run.status === "completed" && (
        <div className="flex gap-2">
          <Link href={`/admin/instances/${run.workspace_id}`}>
            <Button>View Instance</Button>
          </Link>
          <Link href="/admin/instances">
            <Button variant="outline">Back to Instances</Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    pending: "outline",
    running: "secondary",
    completed: "default",
    failed: "destructive",
  };
  return <Badge variant={variants[status] ?? "outline"}>{status}</Badge>;
}
