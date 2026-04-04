"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, Plug } from "lucide-react";

interface McpServer {
  id: string;
  name: string;
  port: number;
  capabilities: string[];
  env_required: string[];
  description?: string;
}

export default function IntegrationsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/integrations");
      const json = await res.json();
      if (json.ok) setServers(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integrations</h1>
          <p className="text-sm text-zinc-500 mt-1">{servers.length} MCP servers in registry</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && servers.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {servers.map((server) => (
            <Card key={server.id} className="transition-shadow hover:shadow-md">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Plug className="h-4 w-4 text-zinc-400" />
                    <CardTitle className="text-base">{server.name}</CardTitle>
                  </div>
                  <Badge variant="outline">:{server.port}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Capabilities</p>
                  <div className="flex flex-wrap gap-1">
                    {server.capabilities.map((cap) => (
                      <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                    ))}
                  </div>
                </div>
                {server.env_required.length > 0 && (
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Required Env Vars</p>
                    <div className="flex flex-wrap gap-1">
                      {server.env_required.map((env) => (
                        <code key={env} className="text-xs bg-zinc-100 px-1 py-0.5 rounded dark:bg-zinc-800">{env}</code>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-xs text-zinc-400 font-mono">{server.id}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
