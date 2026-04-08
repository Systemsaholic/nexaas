"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HealthCards } from "@/components/health-cards";
import { LogViewer } from "@/components/log-viewer";
import { Terminal } from "@/components/terminal";
import { InstanceSkills } from "@/components/instance-skills";
import { InstanceIntegrations } from "@/components/instance-integrations";
import { InstanceKeys } from "@/components/instance-keys";
import { InstanceUsage } from "@/components/instance-usage";
import { MemoryStats } from "@/components/memory-stats";
import { ArrowLeft, RefreshCw, Settings, RotateCcw, TerminalSquare, Activity, Sparkles, Plug, Key, BarChart3, ExternalLink, Brain } from "lucide-react";
import type { HealthSnapshot, WorkspaceManifest } from "@/lib/types";

interface InstanceDetail {
  id: string;
  name: string;
  privateIp: string;
  publicIp: string;
  health: HealthSnapshot | null;
  history: HealthSnapshot[];
  manifest: WorkspaceManifest;
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<InstanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function fetchDetail() {
    try {
      const res = await fetch(`/api/v1/instances/${id}`);
      const json = await res.json();
      if (json.ok) setData(json.data);
    } finally {
      setLoading(false);
    }
  }

  async function refreshHealth() {
    setRefreshing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/instances/${id}/health`, { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        setMessage("Health refreshed");
        fetchDetail();
      } else {
        setMessage(`Refresh failed: ${json.error}`);
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function restartWorker() {
    if (!confirm("Restart the worker on this instance?")) return;
    setRestarting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/instances/${id}/restart`, { method: "POST" });
      const json = await res.json();
      setMessage(json.ok ? "Worker restarted" : `Failed: ${json.error}`);
    } finally {
      setRestarting(false);
    }
  }

  useEffect(() => {
    fetchDetail();
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      </div>
    );
  }

  if (!data) {
    return <p className="text-zinc-500">Instance not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/instances">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{data.name}</h1>
            <p className="text-sm text-zinc-500">{data.privateIp} / {data.publicIp}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refreshHealth} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh Health
          </Button>
          <Button variant="outline" size="sm" onClick={restartWorker} disabled={restarting}>
            <RotateCcw className={`h-4 w-4 mr-2 ${restarting ? "animate-spin" : ""}`} />
            Restart Worker
          </Button>
          <Link href={`/admin/instances/${id}/manage`}>
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              Manage
            </Button>
          </Link>
          <a href={`http://${data.publicIp}:3001`} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink className="h-4 w-4 mr-2" />
              Client Portal
            </Button>
          </a>
        </div>
      </div>

      {message && (
        <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          {message}
        </div>
      )}

      {/* Health Cards */}
      <HealthCards health={data.health} />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview"><Activity className="h-4 w-4 mr-1" /> Overview</TabsTrigger>
          <TabsTrigger value="skills"><Sparkles className="h-4 w-4 mr-1" /> Skills</TabsTrigger>
          <TabsTrigger value="integrations"><Plug className="h-4 w-4 mr-1" /> Integrations</TabsTrigger>
          <TabsTrigger value="keys"><Key className="h-4 w-4 mr-1" /> AI Keys</TabsTrigger>
          <TabsTrigger value="usage"><BarChart3 className="h-4 w-4 mr-1" /> Usage</TabsTrigger>
          <TabsTrigger value="memory"><Brain className="h-4 w-4 mr-1" /> Memory</TabsTrigger>
          <TabsTrigger value="terminal"><TerminalSquare className="h-4 w-4 mr-1" /> Claude Code</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
          {/* Info Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm font-medium mb-1">Skills ({data.manifest.skills.length})</p>
                  {data.manifest.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {data.manifest.skills.map((s) => (
                        <Badge key={s} variant="secondary">{s}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">No skills configured</p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">Agents ({data.manifest.agents.length})</p>
                  {data.manifest.agents.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {data.manifest.agents.map((a) => (
                        <Badge key={a} variant="outline">{a}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">No agents configured</p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">MCP Servers</p>
                  {Object.keys(data.manifest.mcp).length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {Object.keys(data.manifest.mcp).map((m) => (
                        <Badge key={m} variant="outline">{m}</Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">None</p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium mb-1">Capabilities</p>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(data.manifest.capabilities).map(([k, v]) => (
                      <Badge key={k} variant={v ? "default" : "outline"}>
                        {k}: {v ? "yes" : "no"}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Infrastructure</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Trigger Project</span>
                  <span className="font-mono">{data.manifest.trigger.projectId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Private IP</span>
                  <span className="font-mono">{data.privateIp}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Public IP</span>
                  <span className="font-mono">{data.publicIp}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">SSH</span>
                  <span className="font-mono">{data.manifest.ssh.user}@{data.manifest.ssh.host}:{data.manifest.ssh.port}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Workspace Root</span>
                  <span className="font-mono">{data.manifest.workspaceRoot}</span>
                </div>
                {data.health?.snapshot_at && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Last Health Check</span>
                    <span>{new Date(data.health.snapshot_at).toLocaleString()}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <LogViewer instanceId={id} />
        </TabsContent>

        <TabsContent value="skills" className="mt-4">
          <InstanceSkills instanceId={id} />
        </TabsContent>

        <TabsContent value="integrations" className="mt-4">
          <InstanceIntegrations instanceId={id} />
        </TabsContent>

        <TabsContent value="keys" className="mt-4">
          <InstanceKeys instanceId={id} />
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <InstanceUsage instanceId={id} />
        </TabsContent>

        <TabsContent value="memory" className="mt-4">
          <MemoryStats instanceId={id} />
        </TabsContent>

        <TabsContent value="terminal" className="mt-4">
          <Terminal target={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
