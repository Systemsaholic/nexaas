"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, RotateCcw, Container, Terminal, FileText, Rocket, Globe, Check, X, Loader2 } from "lucide-react";
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

      {/* Domain Management */}
      <DomainManager instanceId={id as string} manifest={manifest} />

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

function DomainManager({ instanceId, manifest }: { instanceId: string; manifest: WorkspaceManifest | null }) {
  const [currentDomain, setCurrentDomain] = useState<{ subdomain: string; domain: string } | null>(null);
  const [newSubdomain, setNewSubdomain] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/instances/${instanceId}/domain`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.data.configured) {
          setCurrentDomain({ subdomain: j.data.subdomain, domain: j.data.domain });
        }
      });
  }, [instanceId]);

  async function checkAvailability() {
    if (!newSubdomain) return;
    setChecking(true);
    setAvailable(null);
    try {
      const res = await fetch(`/api/v1/dns/check?subdomain=${newSubdomain}`);
      const json = await res.json();
      setAvailable(json.data?.available ?? false);
    } catch {
      setAvailable(false);
    } finally {
      setChecking(false);
    }
  }

  async function saveDomain() {
    if (!newSubdomain) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: newSubdomain }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage(`Domain configured: ${json.data.domain}`);
        setCurrentDomain({ subdomain: newSubdomain, domain: json.data.domain });
        setNewSubdomain("");
        setAvailable(null);
      } else {
        setMessage(`Error: ${json.error}`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function removeDomain() {
    if (!confirm("Remove the domain? The client dashboard will only be accessible via IP.")) return;
    setRemoving(true);
    try {
      await fetch(`/api/v1/instances/${instanceId}/domain`, { method: "DELETE" });
      setCurrentDomain(null);
      setMessage("Domain removed");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Globe className="h-4 w-4" /> Domain Management
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current domain */}
        {currentDomain ? (
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">{currentDomain.domain}</p>
              <p className="text-xs text-zinc-400">Subdomain: {currentDomain.subdomain}</p>
            </div>
            <div className="flex gap-2">
              <a href={`https://${currentDomain.domain}`} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">Visit</Button>
              </a>
              <Button variant="ghost" size="sm" className="text-red-500" onClick={removeDomain} disabled={removing}>
                {removing ? "Removing..." : "Remove"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No domain configured. Instance accessible via IP only.</p>
        )}

        {/* Set subdomain */}
        <div>
          <label className="text-sm font-medium mb-1 block">
            {currentDomain ? "Change subdomain" : "Set subdomain"}
          </label>
          <div className="flex gap-2">
            <div className="flex items-center gap-1 flex-1">
              <Input
                placeholder="e.g. bsbc"
                value={newSubdomain}
                onChange={(e) => {
                  setNewSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  setAvailable(null);
                }}
              />
              <span className="text-sm text-zinc-400 whitespace-nowrap">.nexmatic.ca</span>
            </div>
            <Button variant="outline" size="sm" onClick={checkAvailability} disabled={!newSubdomain || checking}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check"}
            </Button>
            <Button size="sm" onClick={saveDomain} disabled={!newSubdomain || available === false || saving}>
              {saving ? "Saving..." : "Apply"}
            </Button>
          </div>
          {available === true && (
            <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><Check className="h-3 w-3" /> {newSubdomain}.nexmatic.ca is available</p>
          )}
          {available === false && (
            <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><X className="h-3 w-3" /> {newSubdomain}.nexmatic.ca is already in use</p>
          )}
        </div>

        {message && (
          <p className={`text-sm ${message.startsWith("Error") ? "text-red-500" : "text-green-600"}`}>{message}</p>
        )}
      </CardContent>
    </Card>
  );
}
