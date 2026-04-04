import { Card, CardContent } from "@/components/ui/card";
import { Cpu, HardDrive, Container, Activity } from "lucide-react";
import type { HealthSnapshot } from "@/lib/types";

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div
        className={`h-2 rounded-full ${color}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  );
}

/** High = bad (RAM, disk usage) */
function usageColor(pct: number): string {
  if (pct > 90) return "bg-red-500";
  if (pct > 75) return "bg-yellow-500";
  return "bg-green-500";
}

/** High = good (containers healthy, worker active) */
function healthColor(pct: number): string {
  if (pct >= 100) return "bg-green-500";
  if (pct > 50) return "bg-yellow-500";
  return "bg-red-500";
}

export function HealthCards({ health }: { health: HealthSnapshot | null }) {
  if (!health) {
    return <p className="text-sm text-zinc-400">No health data available.</p>;
  }

  const ramPct = health.ram_total_mb ? Math.round((health.ram_used_mb / health.ram_total_mb) * 100) : 0;
  const diskPct = health.disk_total_gb ? Math.round((health.disk_used_gb / health.disk_total_gb) * 100) : 0;
  const containerPct = health.container_count ? Math.round((health.containers_healthy / health.container_count) * 100) : 0;
  const workerPct = health.worker_active ? 100 : 0;

  const cards = [
    {
      icon: Cpu,
      label: "RAM",
      value: `${health.ram_used_mb} / ${health.ram_total_mb} MB`,
      pct: ramPct,
      color: usageColor(ramPct),
    },
    {
      icon: HardDrive,
      label: "Disk",
      value: `${health.disk_used_gb} / ${health.disk_total_gb} GB`,
      pct: diskPct,
      color: usageColor(diskPct),
    },
    {
      icon: Container,
      label: "Containers",
      value: `${health.containers_healthy} / ${health.container_count} healthy`,
      pct: containerPct,
      color: healthColor(containerPct),
    },
    {
      icon: Activity,
      label: "Worker",
      value: health.worker_active ? "Active" : "Down",
      pct: workerPct,
      color: healthColor(workerPct),
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(({ icon: Icon, label, value, pct, color }) => (
        <Card key={label}>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-2">
              <Icon className="h-4 w-4 text-zinc-400" />
              <span className="text-sm font-medium">{label}</span>
            </div>
            <p className="text-lg font-semibold mb-2">{value}</p>
            <ProgressBar value={pct} color={color} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
