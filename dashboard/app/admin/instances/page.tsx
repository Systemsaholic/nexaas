"use client";

import { useEffect, useState } from "react";
import { InstanceCard } from "@/components/instance-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw } from "lucide-react";
import type { Instance } from "@/lib/types";

export default function InstancesPage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchInstances() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/instances");
      const json = await res.json();
      if (json.ok) {
        setInstances(json.data);
      } else {
        setError(json.error ?? "Failed to load instances");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchInstances();
    const interval = setInterval(fetchInstances, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Instances</h1>
          <p className="text-sm text-zinc-500 mt-1">{instances.length} workspaces</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchInstances} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-4 mb-6 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && instances.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {instances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  );
}
