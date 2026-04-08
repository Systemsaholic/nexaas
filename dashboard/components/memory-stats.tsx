"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Network, BookOpen, Zap, Clock, AlertTriangle } from "lucide-react";
import type { MemorySnapshot } from "@/lib/types";

interface MemoryApiResponse {
  latest: MemorySnapshot | null;
  history: Array<Pick<MemorySnapshot,
    "snapshot_at" | "event_count" | "entity_count" | "active_fact_count" |
    "relation_count" | "embedding_lag" | "events_24h">>;
}

export function MemoryStats({ instanceId }: { instanceId: string }) {
  const [data, setData] = useState<MemoryApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/instances/${instanceId}/memory`)
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) setData(json.data);
      })
      .finally(() => setLoading(false));
  }, [instanceId]);

  if (loading) {
    return <p className="text-sm text-zinc-400">Loading memory stats…</p>;
  }

  if (!data?.latest) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Brain className="h-4 w-4" />
            <span>No memory snapshot yet — collection runs hourly</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const s = data.latest;
  const lagPct = s.event_count > 0 ? Math.round((s.embedding_lag / s.event_count) * 100) : 0;

  const cards = [
    {
      icon: Brain,
      label: "Events",
      value: s.event_count.toLocaleString(),
      sub: `${s.events_24h} in last 24h`,
    },
    {
      icon: Network,
      label: "Entities",
      value: s.entity_count.toLocaleString(),
      sub: `${s.relation_count} relations`,
    },
    {
      icon: BookOpen,
      label: "Active Facts",
      value: s.active_fact_count.toLocaleString(),
      sub: `${s.active_journal_entries} journal open`,
    },
    {
      icon: s.embedding_lag > 0 ? AlertTriangle : Zap,
      label: "Embedding Lag",
      value: s.embedding_lag.toLocaleString(),
      sub: lagPct > 0 ? `${lagPct}% unembedded` : "All caught up",
      warn: lagPct > 10,
    },
  ];

  const typeEntries = Object.entries(s.event_type_breakdown ?? {})
    .sort(([, a], [, b]) => (b as number) - (a as number));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Brain className="h-4 w-4 text-zinc-400" />
          Memory System
        </h3>
        <span className="text-xs text-zinc-500 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {new Date(s.snapshot_at).toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ icon: Icon, label, value, sub, warn }) => (
          <Card key={label}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`h-4 w-4 ${warn ? "text-yellow-500" : "text-zinc-400"}`} />
                <span className="text-sm font-medium">{label}</span>
              </div>
              <p className="text-2xl font-semibold">{value}</p>
              <p className="text-xs text-zinc-500 mt-1">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {typeEntries.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Event Type Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {typeEntries.map(([type, count]) => (
                <Badge key={type} variant="secondary">
                  {type}: {(count as number).toLocaleString()}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {(s.oldest_event || s.newest_event) && (
        <div className="grid grid-cols-2 gap-4 text-xs text-zinc-500">
          {s.oldest_event && (
            <div>Oldest event: {new Date(s.oldest_event).toLocaleString()}</div>
          )}
          {s.newest_event && (
            <div>Newest event: {new Date(s.newest_event).toLocaleString()}</div>
          )}
        </div>
      )}
    </div>
  );
}
