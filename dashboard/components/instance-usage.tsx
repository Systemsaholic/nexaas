"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Zap, DollarSign, Cpu, BarChart3 } from "lucide-react";

interface UsageData {
  summary: {
    total_calls: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    total_cost: number;
  };
  daily: Array<{ date: string; calls: number; tokens: number; cost: number }>;
  byModel: Array<{ model: string; calls: number; input_tokens: number; output_tokens: number; cost: number }>;
  byAgent: Array<{ agent: string; calls: number; tokens: number; cost: number }>;
  days: number;
}

export function InstanceUsage({ instanceId }: { instanceId: string }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch_() {
      try {
        const res = await fetch(`/api/v1/instances/${instanceId}/usage?days=30`);
        const json = await res.json();
        if (json.ok) setData(json.data);
      } finally {
        setLoading(false);
      }
    }
    fetch_();
  }, [instanceId]);

  if (loading) return <p className="text-sm text-zinc-400">Loading usage data...</p>;
  if (!data) return <p className="text-sm text-zinc-400">No usage data available.</p>;

  const s = data.summary;
  const formatCost = (c: number) => `$${(c || 0).toFixed(4)}`;
  const formatTokens = (t: number) => t >= 1000000 ? `${(t / 1000000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}K` : String(t || 0);

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-zinc-400" /><span className="text-sm font-medium">API Calls</span></div>
            <p className="text-2xl font-bold">{s.total_calls || 0}</p>
            <p className="text-xs text-zinc-400">Last {data.days} days</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Cpu className="h-4 w-4 text-zinc-400" /><span className="text-sm font-medium">Total Tokens</span></div>
            <p className="text-2xl font-bold">{formatTokens(s.total_tokens)}</p>
            <p className="text-xs text-zinc-400">{formatTokens(s.total_input)} in / {formatTokens(s.total_output)} out</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><DollarSign className="h-4 w-4 text-zinc-400" /><span className="text-sm font-medium">Total Cost</span></div>
            <p className="text-2xl font-bold">{formatCost(s.total_cost)}</p>
            <p className="text-xs text-zinc-400">Last {data.days} days</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><BarChart3 className="h-4 w-4 text-zinc-400" /><span className="text-sm font-medium">Avg/Call</span></div>
            <p className="text-2xl font-bold">{s.total_calls ? formatCost(s.total_cost / s.total_calls) : "$0"}</p>
            <p className="text-xs text-zinc-400">{s.total_calls ? formatTokens(Math.round(s.total_tokens / s.total_calls)) : "0"} tokens/call</p>
          </CardContent>
        </Card>
      </div>

      {/* By Model */}
      {data.byModel.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Usage by Model</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Input</TableHead>
                  <TableHead>Output</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byModel.map((row) => (
                  <TableRow key={row.model}>
                    <TableCell className="font-mono text-sm">{row.model}</TableCell>
                    <TableCell>{row.calls}</TableCell>
                    <TableCell>{formatTokens(row.input_tokens)}</TableCell>
                    <TableCell>{formatTokens(row.output_tokens)}</TableCell>
                    <TableCell className="font-medium">{formatCost(row.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* By Agent/Skill */}
      {data.byAgent.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Usage by Skill/Agent</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill/Agent</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byAgent.map((row) => (
                  <TableRow key={row.agent}>
                    <TableCell className="font-mono text-sm">{row.agent}</TableCell>
                    <TableCell>{row.calls}</TableCell>
                    <TableCell>{formatTokens(row.tokens)}</TableCell>
                    <TableCell className="font-medium">{formatCost(row.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {s.total_calls === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-zinc-400">
            No AI usage recorded yet. Usage is tracked when skills execute and call AI models.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
