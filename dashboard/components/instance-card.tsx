import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Cpu, HardDrive, Container, Activity } from "lucide-react";
import type { Instance } from "@/lib/types";

function statusStyle(instance: Instance): { label: string; className: string } {
  if (!instance.health) {
    return { label: "No data", className: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
  }
  if (!instance.health.worker_active || instance.health.containers_healthy === 0) {
    return { label: "Down", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400" };
  }
  if (instance.health.containers_healthy < instance.health.container_count) {
    return { label: "Degraded", className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400" };
  }
  return { label: "Healthy", className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400" };
}

function ramPercent(h: Instance["health"]): number {
  if (!h || !h.ram_total_mb) return 0;
  return Math.round((h.ram_used_mb / h.ram_total_mb) * 100);
}

function diskPercent(h: Instance["health"]): number {
  if (!h || !h.disk_total_gb) return 0;
  return Math.round((h.disk_used_gb / h.disk_total_gb) * 100);
}

export function InstanceCard({ instance }: { instance: Instance }) {
  const h = instance.health;
  const status = statusStyle(instance);

  return (
    <Link href={`/admin/instances/${instance.id}`}>
      <Card className="transition-shadow hover:shadow-md cursor-pointer">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base font-semibold">{instance.name}</CardTitle>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${status.className}`}>
            {status.label}
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-zinc-500">{instance.privateIp} / {instance.publicIp}</p>

          {h ? (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Cpu className="h-3.5 w-3.5 text-zinc-400" />
                <span>RAM {ramPercent(h)}%</span>
                <span className="text-xs text-zinc-400">{h.ram_used_mb}/{h.ram_total_mb}M</span>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive className="h-3.5 w-3.5 text-zinc-400" />
                <span>Disk {diskPercent(h)}%</span>
                <span className="text-xs text-zinc-400">{h.disk_used_gb}/{h.disk_total_gb}G</span>
              </div>
              <div className="flex items-center gap-2">
                <Container className="h-3.5 w-3.5 text-zinc-400" />
                <span>{h.containers_healthy}/{h.container_count} containers</span>
              </div>
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-zinc-400" />
                <span>{h.worker_active ? "Worker up" : "Worker down"}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">No health data yet</p>
          )}

          {(instance.manifest.skills.length > 0 || instance.manifest.agents.length > 0) && (
            <div className="flex gap-2 flex-wrap">
              {instance.manifest.skills.length > 0 && (
                <span className="text-xs text-zinc-500">{instance.manifest.skills.length} skills</span>
              )}
              {instance.manifest.agents.length > 0 && (
                <span className="text-xs text-zinc-500">{instance.manifest.agents.length} agents</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
