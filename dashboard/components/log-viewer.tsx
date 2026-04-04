"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RefreshCw } from "lucide-react";

export function LogViewer({ instanceId }: { instanceId: string }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchLogs() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/logs`);
      const json = await res.json();
      setLogs(json.data?.logs ?? "Failed to fetch logs");
    } catch {
      setLogs("Error fetching logs");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">Worker Logs</h3>
        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
          {logs === null ? "Load logs" : "Refresh"}
        </Button>
      </div>
      {logs !== null && (
        <ScrollArea className="h-64 rounded-md border bg-zinc-950 p-3">
          <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{logs}</pre>
        </ScrollArea>
      )}
    </div>
  );
}
