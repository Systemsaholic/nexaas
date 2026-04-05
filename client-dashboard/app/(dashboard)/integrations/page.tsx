"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, CheckCircle2, AlertCircle, Circle } from "lucide-react";

interface Provider {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  connection: {
    status: string;
    connected_at: string | null;
    error_message: string | null;
  } | null;
}

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchProviders() {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      if (json.ok) setProviders(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchProviders(); }, []);

  function StatusIcon({ status }: { status: string | null }) {
    if (!status || status === "pending") return <Circle className="h-4 w-4 text-zinc-300" />;
    if (status === "connected") return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === "error") return <AlertCircle className="h-4 w-4 text-red-500" />;
    return <Circle className="h-4 w-4 text-zinc-300" />;
  }

  const connected = providers.filter((p) => p.connection?.status === "connected");
  const available = providers.filter((p) => p.connection?.status !== "connected");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integrations</h1>
          <p className="text-sm text-zinc-500 mt-1">{connected.length} connected, {available.length} available</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchProviders} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Connected */}
      {connected.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-zinc-500 mb-3">Connected</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {connected.map((p) => (
              <Card key={p.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{p.icon}</span>
                      <div>
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-zinc-400">{p.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
                      </span>
                      <Button variant="ghost" size="sm" className="text-xs text-red-500">Disconnect</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Available */}
      <div>
        <h2 className="text-sm font-medium text-zinc-500 mb-3">Available</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {available.map((p) => (
            <Card key={p.id} className="transition-shadow hover:shadow-md">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{p.icon}</span>
                    <div>
                      <p className="text-sm font-medium">{p.name}</p>
                      <p className="text-xs text-zinc-400">{p.description}</p>
                    </div>
                  </div>
                  <Button size="sm">Connect</Button>
                </div>
                {p.connection?.error_message && (
                  <p className="text-xs text-red-500 mt-2">{p.connection.error_message}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
