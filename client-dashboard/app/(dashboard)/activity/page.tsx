"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

interface ActivityEntry {
  id: number;
  skill_id: string | null;
  action: string;
  summary: string;
  tag_route: string | null;
  created_at: string;
}

const routeColors: Record<string, string> = {
  auto_execute: "bg-green-100 text-green-700",
  notify_after: "bg-blue-100 text-blue-700",
  approval_required: "bg-yellow-100 text-yellow-700",
  escalate: "bg-orange-100 text-orange-700",
  flag: "bg-red-100 text-red-700",
};

export default function ActivityPage() {
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchActivity() {
    setLoading(true);
    try {
      const res = await fetch("/api/activity?limit=100");
      const json = await res.json();
      if (json.ok) setActivity(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchActivity(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activity</h1>
          <p className="text-sm text-zinc-500 mt-1">What your AI has been doing</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchActivity} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="pt-4">
          {activity.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-8">No activity yet. Actions will appear here once skills are running.</p>
          ) : (
            <div className="space-y-2">
              {activity.map((a) => (
                <div key={a.id} className="flex items-start justify-between rounded-md border p-3">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{a.summary}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {a.skill_id && <span className="text-xs text-zinc-400 font-mono">{a.skill_id}</span>}
                      <span className="text-xs text-zinc-400">{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                  {a.tag_route && (
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${routeColors[a.tag_route] ?? "bg-zinc-100 text-zinc-500"}`}>
                      {a.tag_route.replace("_", " ")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
