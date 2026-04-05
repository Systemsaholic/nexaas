"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Rocket, Server, Cloud } from "lucide-react";

const FLAVORS = [
  { id: "d2-8", label: "Standard", desc: "2 vCPU, 8GB RAM, 80GB disk" },
  { id: "b3-16", label: "Pro", desc: "4 vCPU, 16GB RAM, 200GB disk" },
  { id: "b3-32", label: "Enterprise", desc: "8 vCPU, 32GB RAM, 400GB disk" },
];

export default function DeployPage() {
  return (
    <Suspense>
      <DeployForm />
    </Suspense>
  );
}

function DeployForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isRedeploy = searchParams.has("redeploy");

  const [mode, setMode] = useState<"new_vps" | "existing">(isRedeploy ? "existing" : "new_vps");
  const [workspaceId, setWorkspaceId] = useState(searchParams.get("redeploy") ?? "");
  const [vpsIp, setVpsIp] = useState(searchParams.get("ip") ?? "");
  const [adminEmail, setAdminEmail] = useState("al@systemsaholic.com");
  const [appOrigin, setAppOrigin] = useState("http://localhost:3040");
  const [flavor, setFlavor] = useState("d2-8");
  const [subdomain, setSubdomain] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeploy(e: React.FormEvent) {
    e.preventDefault();
    setDeploying(true);
    setError(null);

    try {
      const endpoint = mode === "new_vps" ? "/api/v1/infrastructure/provision" : "/api/v1/deploys";
      const body = mode === "new_vps"
        ? { workspaceId, adminEmail, flavor, appOrigin, subdomain: subdomain || undefined }
        : { workspaceId, vpsIp, adminEmail, appOrigin };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (json.ok) {
        router.push(`/admin/deploy/${json.data.id}`);
      } else {
        setError(json.error ?? "Deploy failed to start");
        setDeploying(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setDeploying(false);
    }
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-6">Deploy New Instance</h1>

      <Tabs value={mode} onValueChange={(v) => setMode(v as "new_vps" | "existing")}>
        <TabsList className="mb-4">
          <TabsTrigger value="new_vps">
            <Cloud className="h-4 w-4 mr-2" />
            New VPS
          </TabsTrigger>
          <TabsTrigger value="existing">
            <Server className="h-4 w-4 mr-2" />
            Existing VPS
          </TabsTrigger>
        </TabsList>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {mode === "new_vps" ? "Create VPS + Deploy" : "Deploy to Existing VPS"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleDeploy} className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Workspace ID</label>
                <Input
                  placeholder="e.g. acme-corp"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  required
                />
                <p className="text-xs text-zinc-400 mt-1">Lowercase, no spaces.</p>
              </div>

              <div>
                <label className="text-sm font-medium mb-1 block">Admin Email</label>
                <Input
                  type="email"
                  placeholder="admin@example.com"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  required
                />
              </div>

              <TabsContent value="new_vps" className="mt-0 p-0 space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">VPS Size</label>
                  <div className="grid gap-2">
                    {FLAVORS.map((f) => (
                      <label
                        key={f.id}
                        className={`flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-colors ${
                          flavor === f.id
                            ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                            : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <input
                            type="radio"
                            name="flavor"
                            value={f.id}
                            checked={flavor === f.id}
                            onChange={() => setFlavor(f.id)}
                            className="accent-zinc-900"
                          />
                          <div>
                            <span className="text-sm font-medium">{f.label}</span>
                            <p className="text-xs text-zinc-500">{f.desc}</p>
                          </div>
                        </div>
                        <Badge variant="outline">{f.id}</Badge>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Subdomain (optional)</label>
                  <div className="flex items-center gap-1">
                    <Input
                      placeholder="e.g. bsbc"
                      value={subdomain}
                      onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    />
                    <span className="text-sm text-zinc-400 whitespace-nowrap">.nexmatic.ca</span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">Client dashboard URL. Leave blank to configure later.</p>
                </div>
                <p className="text-xs text-zinc-400">
                  Region: BHS (Canada). DNS + SSL configured automatically via Caddy.
                </p>
              </TabsContent>

              <TabsContent value="existing" className="mt-0 p-0 space-y-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">VPS IP Address</label>
                  <Input
                    placeholder="e.g. 10.10.0.13"
                    value={vpsIp}
                    onChange={(e) => setVpsIp(e.target.value)}
                    required={mode === "existing"}
                  />
                  <p className="text-xs text-zinc-400 mt-1">Private VLAN IP. SSH must be authorized from orchestrator.</p>
                </div>
              </TabsContent>

              <div>
                <label className="text-sm font-medium mb-1 block">App Origin</label>
                <Input
                  placeholder="http://localhost:3040"
                  value={appOrigin}
                  onChange={(e) => setAppOrigin(e.target.value)}
                />
                <p className="text-xs text-zinc-400 mt-1">Trigger.dev dashboard URL.</p>
              </div>

              {error && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                disabled={deploying || !workspaceId || !adminEmail || (mode === "existing" && !vpsIp)}
                className="w-full"
              >
                <Rocket className="h-4 w-4 mr-2" />
                {deploying
                  ? "Starting..."
                  : mode === "new_vps"
                  ? "Create VPS & Deploy"
                  : "Deploy to Existing VPS"
                }
              </Button>
            </form>
          </CardContent>
        </Card>
      </Tabs>
    </div>
  );
}
