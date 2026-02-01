"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircleIcon } from "lucide-react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

interface UsageSummary {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  by_model: { model: string; calls: number; cost_usd: number }[];
  by_agent: { agent: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }[];
  daily: { date: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number }[];
}

interface AnalyticsChartsConfig {
  [key: string]: unknown;
}

const agentColors = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c"];

export default function AnalyticsCharts({
  config,
  title,
}: {
  config: AnalyticsChartsConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getUsage()
      .then((d) => {
        if (!cancelled) setData(d as UsageSummary);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load analytics");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Analytics"}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Analytics"}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <AlertCircleIcon className="size-8 text-destructive" />
            <p className="text-sm text-destructive">{fetchError}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Analytics"}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No usage data available.</p>
        </CardContent>
      </Card>
    );
  }

  const daily = [...data.daily].reverse().slice(-14);
  const maxTokens = Math.max(...daily.map((d) => d.input_tokens + d.output_tokens), 1);
  const maxCost = Math.max(...daily.map((d) => d.cost_usd), 0.001);

  const byAgent = data.by_agent.slice(0, 6);
  const totalAgentCost = byAgent.reduce((s, a) => s + a.cost_usd, 0) || 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Analytics"}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Daily tokens bar chart */}
        <div>
          <h4 className="mb-3 text-xs font-medium text-muted-foreground">Daily Token Usage (14d)</h4>
          <div className="flex h-32 items-end gap-1">
            {daily.map((d, i) => {
              const inp = d.input_tokens;
              const out = d.output_tokens;
              const total = inp + out;
              const height = (total / maxTokens) * 100;
              const inpPct = total > 0 ? (inp / total) * 100 : 50;
              return (
                <div key={i} className="group relative flex flex-1 flex-col items-center">
                  <div
                    className="w-full rounded-t-sm overflow-hidden"
                    style={{ height: `${Math.max(height, 2)}%` }}
                  >
                    <div
                      className="w-full bg-blue-400"
                      style={{ height: `${inpPct}%` }}
                    />
                    <div
                      className="w-full bg-emerald-400"
                      style={{ height: `${100 - inpPct}%` }}
                    />
                  </div>
                  <span className="mt-1 text-[8px] text-muted-foreground">
                    {d.date.slice(5)}
                  </span>
                  {/* Tooltip */}
                  <div className="pointer-events-none absolute -top-14 left-1/2 z-10 hidden -translate-x-1/2 rounded bg-popover px-2 py-1 text-[10px] shadow-md group-hover:block">
                    <div>{(total / 1000).toFixed(1)}K tokens</div>
                    <div>${d.cost_usd.toFixed(3)}</div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-blue-400" /> Input
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" /> Output
            </span>
          </div>
        </div>

        {/* Cost by agent donut */}
        <div>
          <h4 className="mb-3 text-xs font-medium text-muted-foreground">Cost by Agent</h4>
          <div className="flex items-center gap-4">
            <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0">
              {(() => {
                let offset = 0;
                return byAgent.map((a, i) => {
                  const pct = (a.cost_usd / totalAgentCost) * 100;
                  const dashArray = `${pct} ${100 - pct}`;
                  const el = (
                    <circle
                      key={a.agent}
                      cx="50"
                      cy="50"
                      r="40"
                      fill="none"
                      stroke={agentColors[i % agentColors.length]}
                      strokeWidth="12"
                      strokeDasharray={dashArray}
                      strokeDashoffset={-offset}
                      className="transition-all"
                      style={{ transformOrigin: "center" }}
                    />
                  );
                  offset += pct;
                  return el;
                });
              })()}
              <text x="50" y="48" textAnchor="middle" className="fill-foreground text-[10px] font-bold">
                ${data.total_cost_usd.toFixed(2)}
              </text>
              <text x="50" y="58" textAnchor="middle" className="fill-muted-foreground text-[6px]">
                total
              </text>
            </svg>
            <div className="flex flex-col gap-1.5">
              {byAgent.map((a, i) => (
                <div key={a.agent} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: agentColors[i % agentColors.length] }}
                  />
                  <span className="font-medium">{a.agent}</span>
                  <span className="ml-auto text-muted-foreground">${a.cost_usd.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Daily cost line */}
        <div>
          <h4 className="mb-3 text-xs font-medium text-muted-foreground">Daily Cost Trend (14d)</h4>
          <svg viewBox="0 0 280 80" className="h-24 w-full">
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
              <line
                key={pct}
                x1="0"
                y1={75 - pct * 70}
                x2="280"
                y2={75 - pct * 70}
                stroke="currentColor"
                strokeOpacity="0.1"
                strokeWidth="0.5"
              />
            ))}
            {/* Line */}
            <polyline
              fill="none"
              stroke="#34d399"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={daily
                .map((d, i) => {
                  const x = (i / Math.max(daily.length - 1, 1)) * 270 + 5;
                  const y = 75 - (d.cost_usd / maxCost) * 70;
                  return `${x},${y}`;
                })
                .join(" ")}
            />
            {/* Area fill */}
            <polygon
              fill="#34d399"
              fillOpacity="0.1"
              points={
                daily
                  .map((d, i) => {
                    const x = (i / Math.max(daily.length - 1, 1)) * 270 + 5;
                    const y = 75 - (d.cost_usd / maxCost) * 70;
                    return `${x},${y}`;
                  })
                  .join(" ") +
                ` 275,75 5,75`
              }
            />
            {/* Dots */}
            {daily.map((d, i) => {
              const x = (i / Math.max(daily.length - 1, 1)) * 270 + 5;
              const y = 75 - (d.cost_usd / maxCost) * 70;
              return (
                <circle key={i} cx={x} cy={y} r="2.5" fill="#34d399" />
              );
            })}
          </svg>
        </div>

        {/* Calls by model */}
        <div>
          <h4 className="mb-3 text-xs font-medium text-muted-foreground">API Calls by Model</h4>
          <div className="flex flex-col gap-2">
            {data.by_model.map((m) => {
              const pct = data.total_calls > 0 ? (m.calls / data.total_calls) * 100 : 0;
              return (
                <div key={m.model} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{m.model.replace("claude-", "").replace(/-\d+$/, "")}</span>
                    <span className="text-muted-foreground">{m.calls} calls · ${m.cost_usd.toFixed(3)}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
