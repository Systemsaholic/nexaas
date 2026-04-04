"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, CheckCircle2, XCircle, Plug, Circle } from "lucide-react";

interface InstanceIntegration {
  id: string;
  name: string;
  capabilities: string[];
  requiredEnv: string[];
  defaultPort: number;
  enabled: boolean;
  status: string;
  config: Record<string, unknown> | null;
  lastChecked: string | null;
  errorMessage: string | null;
}

export function InstanceIntegrations({ instanceId }: { instanceId: string }) {
  const [integrations, setIntegrations] = useState<InstanceIntegration[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchIntegrations() {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/instances/${instanceId}/integrations`);
      const json = await res.json();
      if (json.ok) setIntegrations(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchIntegrations(); }, [instanceId]);

  const enabled = integrations.filter((i) => i.enabled);
  const available = integrations.filter((i) => !i.enabled);

  function StatusIcon({ status }: { status: string }) {
    switch (status) {
      case "connected": return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case "configured": return <Circle className="h-4 w-4 text-blue-500" />;
      case "error": return <XCircle className="h-4 w-4 text-red-500" />;
      default: return <Circle className="h-4 w-4 text-zinc-300" />;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{enabled.length} enabled, {available.length} available</h3>
        <Button variant="outline" size="sm" onClick={fetchIntegrations} disabled={loading}>
          <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Enabled Integrations */}
      <Card>
        <CardHeader><CardTitle className="text-base">Enabled Integrations</CardTitle></CardHeader>
        <CardContent>
          {enabled.length === 0 ? (
            <p className="text-sm text-zinc-400">No integrations enabled.</p>
          ) : (
            <div className="space-y-3">
              {enabled.map((integration) => (
                <div key={integration.id} className="flex items-center justify-between rounded-md border p-3">
                  <div className="flex items-center gap-3">
                    <StatusIcon status={integration.status} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{integration.name}</span>
                        <Badge variant="outline" className="text-xs">:{integration.defaultPort}</Badge>
                      </div>
                      <div className="flex gap-1 mt-1">
                        {integration.capabilities.slice(0, 4).map((cap) => (
                          <Badge key={cap} variant="secondary" className="text-xs">{cap}</Badge>
                        ))}
                        {integration.capabilities.length > 4 && (
                          <Badge variant="secondary" className="text-xs">+{integration.capabilities.length - 4}</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      integration.status === "connected" ? "bg-green-100 text-green-700" :
                      integration.status === "configured" ? "bg-blue-100 text-blue-700" :
                      integration.status === "error" ? "bg-red-100 text-red-700" :
                      "bg-zinc-100 text-zinc-500"
                    }`}>{integration.status}</span>
                    {integration.errorMessage && (
                      <p className="text-xs text-red-500 mt-1 max-w-xs truncate">{integration.errorMessage}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Available */}
      {available.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Available ({available.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {available.map((integration) => (
                <div key={integration.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <Plug className="h-3 w-3 text-zinc-400" />
                  <span className="text-xs text-zinc-500">{integration.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
