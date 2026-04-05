"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plug, CheckSquare, Activity, Zap } from "lucide-react";

interface DashboardStats {
  activeSkills: number;
  pendingApprovals: number;
  recentActivity: number;
  tokensThisMonth: number;
}

interface RecentActivity {
  id: number;
  action: string;
  summary: string;
  skill_id: string | null;
  tag_route: string | null;
  created_at: string;
}

export default function DashboardHome() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activity, setActivity] = useState<RecentActivity[]>([]);

  useEffect(() => {
    fetch("/api/dashboard/stats").then((r) => r.json()).then((j) => { if (j.ok) setStats(j.data); });
    fetch("/api/activity?limit=10").then((r) => r.json()).then((j) => { if (j.ok) setActivity(j.data); });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Your AI automation overview</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-blue-500" /><span className="text-sm">Active Skills</span></div>
            <p className="text-2xl font-bold">{stats?.activeSkills ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><CheckSquare className="h-4 w-4 text-yellow-500" /><span className="text-sm">Pending Approvals</span></div>
            <p className="text-2xl font-bold">{stats?.pendingApprovals ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Activity className="h-4 w-4 text-green-500" /><span className="text-sm">Actions Today</span></div>
            <p className="text-2xl font-bold">{stats?.recentActivity ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Plug className="h-4 w-4 text-purple-500" /><span className="text-sm">Tokens This Month</span></div>
            <p className="text-2xl font-bold">{stats?.tokensThisMonth ? `${(stats.tokensThisMonth / 1000).toFixed(0)}K` : "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-sm text-zinc-400">No activity yet. Your AI will start logging actions once skills are activated.</p>
          ) : (
            <div className="space-y-2">
              {activity.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="text-sm">{a.summary}</p>
                    <p className="text-xs text-zinc-400">{a.skill_id ?? a.action} — {new Date(a.created_at).toLocaleString()}</p>
                  </div>
                  {a.tag_route && (
                    <Badge variant={a.tag_route === "auto_execute" ? "default" : a.tag_route === "approval_required" ? "secondary" : "outline"} className="text-xs">
                      {a.tag_route}
                    </Badge>
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
