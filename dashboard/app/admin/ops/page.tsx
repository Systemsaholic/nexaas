"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOpsStore } from "@/lib/stores/ops-store";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import type { OpsAlert, OpsHealthSnapshot } from "@/lib/types";

// ---------------------------------------------------------------------------
// Health status card
// ---------------------------------------------------------------------------

function statusColor(ok: boolean): string {
  return ok ? "bg-green-500" : "bg-red-500";
}

function HealthCard({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusColor(ok)}`} />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{detail ?? (ok ? "Healthy" : "Unhealthy")}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: OpsAlert["severity"] }) {
  const variant =
    severity === "critical"
      ? "destructive"
      : severity === "warning"
        ? "outline"
        : "secondary";
  return <Badge variant={variant as "destructive" | "outline" | "secondary"}>{severity}</Badge>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminOpsPage() {
  const { health, alerts, loading, fetchHealth, fetchAlerts, acknowledge, heal } = useOpsStore();
  const { activeWorkspaceId, gateways, addGateway, setActiveWorkspace, connectionStatus } =
    useWorkspaceStore();

  const [healLoading, setHealLoading] = useState<string | null>(null);

  // Bootstrap gateway if needed (same pattern as workspace pages)
  useEffect(() => {
    if (gateways.size > 0) return;
    fetch("/api/gateway/config")
      .then((res) => res.json())
      .then((data: { id: string; name: string; url: string; apiKey: string }) => {
        if (data.url && data.apiKey) {
          addGateway(data.id, { url: data.url, apiKey: data.apiKey, name: data.name });
        }
      })
      .catch(() => {});
  }, [gateways.size, addGateway]);

  useEffect(() => {
    if (!activeWorkspaceId && gateways.size > 0) {
      const firstId = gateways.keys().next().value;
      if (firstId) setActiveWorkspace(firstId);
    }
  }, [activeWorkspaceId, gateways, setActiveWorkspace]);

  // Fetch data
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    fetchHealth();
    fetchAlerts();
    const interval = setInterval(() => {
      fetchHealth();
      fetchAlerts();
    }, 15_000);
    return () => clearInterval(interval);
  }, [connectionStatus, fetchHealth, fetchAlerts]);

  // SSE subscription for real-time alerts
  useEffect(() => {
    const client = useWorkspaceStore.getState().getActiveGatewayClient();
    if (!client) return;
    const es = client.subscribeEvents((event) => {
      const data = event as unknown as Record<string, unknown>;
      if (data.type === "ops.alert") {
        const payload = data.data as Record<string, unknown>;
        const alert: OpsAlert = {
          id: Date.now(),
          severity: (payload.severity as OpsAlert["severity"]) ?? "info",
          category: (payload.category as string) ?? "unknown",
          message: (payload.message as string) ?? "",
          auto_healed: (payload.auto_healed as boolean) ?? false,
          acknowledged: false,
          details: (payload.details as Record<string, unknown>) ?? null,
          created_at: new Date().toISOString(),
        };
        useOpsStore.getState().pushAlert(alert);
        if (alert.severity === "critical") {
          toast.error(alert.message, { description: alert.category });
        }
      }
    });
    return () => es.close();
  }, [connectionStatus]);

  const handleHeal = useCallback(
    async (action: string) => {
      if (!confirm(`Run heal action: ${action}?`)) return;
      setHealLoading(action);
      try {
        const result = await heal(action);
        toast.success(result);
        fetchHealth();
        fetchAlerts();
      } catch (err) {
        toast.error(String(err));
      } finally {
        setHealLoading(null);
      }
    },
    [heal, fetchHealth, fetchAlerts],
  );

  if (connectionStatus !== "connected") {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        {connectionStatus === "connecting" ? "Connecting to gateway..." : "No gateway connection"}
      </div>
    );
  }

  const h: OpsHealthSnapshot = health ?? {
    engine_running: true,
    worker_count: 0,
    workers_alive: 0,
    pending_jobs: 0,
    failed_jobs_last_hour: 0,
    stale_locks: 0,
    db_ok: true,
    snapshot_at: null,
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Health panel */}
      <section>
        <h2 className="text-lg font-semibold mb-3">System Health</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <HealthCard label="Event Engine" ok={h.engine_running} />
          <HealthCard
            label="Workers"
            ok={h.workers_alive > 0}
            detail={`${h.workers_alive}/${h.worker_count} alive`}
          />
          <HealthCard label="Database" ok={h.db_ok} />
          <HealthCard
            label="Jobs"
            ok={h.failed_jobs_last_hour <= 10 && h.pending_jobs < 50}
            detail={`${h.pending_jobs} pending, ${h.failed_jobs_last_hour} failed/hr`}
          />
        </div>
        {h.snapshot_at && (
          <p className="text-xs text-muted-foreground mt-2">
            Last snapshot: {new Date(h.snapshot_at).toLocaleString()}
          </p>
        )}
      </section>

      {/* Manual actions */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Manual Actions</h2>
        <div className="flex flex-wrap gap-2">
          {["restart_workers", "restart_engine", "clear_locks", "fail_stale_jobs"].map((action) => (
            <Button
              key={action}
              variant="outline"
              size="sm"
              disabled={healLoading !== null}
              onClick={() => handleHeal(action)}
            >
              {healLoading === action ? "Running..." : action.replace(/_/g, " ")}
            </Button>
          ))}
        </div>
      </section>

      {/* Alerts feed */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Alerts</h2>
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        <ScrollArea className="h-[400px] border rounded-md">
          <div className="divide-y">
            {alerts.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No alerts</p>
            )}
            {alerts.map((alert) => (
              <div key={alert.id} className="p-3 flex items-start gap-3">
                <SeverityBadge severity={alert.severity} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{alert.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {alert.category} &middot; {new Date(alert.created_at).toLocaleString()}
                    {alert.auto_healed && (
                      <span className="ml-2 text-green-600">auto-healed</span>
                    )}
                  </p>
                </div>
                {!alert.acknowledged && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => acknowledge(alert.id)}
                  >
                    Ack
                  </Button>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </section>
    </div>
  );
}
