"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, RotateCcw, Container, Terminal, FileText, Rocket } from "lucide-react";
import type { WorkspaceManifest } from "@/lib/types";

export default function ManagePage() {
  const { id } = useParams<{ id: string }>();
  const [manifest, setManifest] = useState<WorkspaceManifest | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [outputLabel, setOutputLabel] = useState("");
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/instances/${id}`)
      .then((r) => r.json())
      .then((json) => { if (json.ok) setManifest(json.data.manifest); });
  }, [id]);

  async function runAction(action: string, label: string) {
    setRunning(action);
    setOutput(null);
    setOutputLabel(label);
    try {
      const res = await fetch(`/api/v1/instances/${id}/manage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      setOutput(json.data?.output ?? json.error ?? "No output");
    } catch (e) {
      setOutput(`Error: ${(e as Error).message}`);
    } finally {
      setRunning(null);
    }
  }

  const actions = [
    { id: "worker-status", label: "Worker Status", icon: Terminal, variant: "outline" as const },
    { id: "container-status", label: "Container Status", icon: Container, variant: "outline" as const },
    { id: "env-vars", label: "View Env Vars", icon: FileText, variant: "outline" as const },
    { id: "restart-worker", label: "Restart Worker", icon: RotateCcw, variant: "outline" as const },
    { id: "restart-containers", label: "Restart All Containers", icon: Container, variant: "destructive" as const },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/admin/instances/${id}`}>
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Manage: {manifest?.name ?? id}</h1>
          <p className="text-sm text-zinc-500">{manifest?.network?.privateIp}</p>
        </div>
      </div>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <Button
                key={a.id}
                variant={a.variant}
                size="sm"
                onClick={() => {
                  if (a.id.startsWith("restart") && !confirm(`Run "${a.label}" on ${id}?`)) return;
                  runAction(a.id, a.label);
                }}
                disabled={running === a.id}
              >
                <a.icon className={`h-4 w-4 mr-2 ${running === a.id ? "animate-spin" : ""}`} />
                {a.label}
              </Button>
            ))}
            <Link href={`/admin/deploy?redeploy=${id}&ip=${manifest?.network?.privateIp ?? ""}`}>
              <Button variant="outline" size="sm">
                <Rocket className="h-4 w-4 mr-2" />
                Redeploy
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Output */}
      {output !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{outputLabel}</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 rounded-md border bg-zinc-950 p-3">
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{output}</pre>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Manifest Viewer */}
      {manifest && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workspace Manifest</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-80 rounded-md border bg-zinc-950 p-3">
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">
                {JSON.stringify(manifest, null, 2)}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
