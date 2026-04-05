"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign, Zap, Cpu, CreditCard } from "lucide-react";

interface UsageData {
  summary: { total_calls: string; total_tokens: string; total_cost: string };
  byModel: Array<{ model: string; calls: string; tokens: string; cost: string }>;
  bySkill: Array<{ skill: string; calls: string; tokens: string; cost: string }>;
}

export default function BillingPage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    fetch("/api/billing/usage").then((r) => r.json()).then((j) => {
      if (j.ok) setUsage(j.data);
    });
  }, []);

  async function openPortal() {
    setPortalLoading(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const json = await res.json();
      if (json.ok) {
        window.location.href = json.data.url;
      }
    } finally {
      setPortalLoading(false);
    }
  }

  const fmt = (n: string | number) => {
    const v = typeof n === "string" ? parseFloat(n) : n;
    return isNaN(v) ? "0" : v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(Math.round(v));
  };
  const fmtCost = (n: string | number) => `$${(parseFloat(String(n)) || 0).toFixed(4)}`;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-sm text-zinc-500 mt-1">This month's usage and subscription</p>
        </div>
        <Button onClick={openPortal} disabled={portalLoading}>
          <CreditCard className="h-4 w-4 mr-2" />
          {portalLoading ? "Opening..." : "Manage Subscription"}
        </Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-yellow-500" /><span className="text-sm">API Calls</span></div>
            <p className="text-2xl font-bold">{usage ? fmt(usage.summary.total_calls) : "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Cpu className="h-4 w-4 text-blue-500" /><span className="text-sm">Tokens</span></div>
            <p className="text-2xl font-bold">{usage ? fmt(usage.summary.total_tokens) : "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><DollarSign className="h-4 w-4 text-green-500" /><span className="text-sm">Cost</span></div>
            <p className="text-2xl font-bold">{usage ? fmtCost(usage.summary.total_cost) : "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* By Model */}
      {usage && usage.byModel.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Usage by Model</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.byModel.map((r) => (
                  <TableRow key={r.model}>
                    <TableCell className="font-mono text-sm">{r.model}</TableCell>
                    <TableCell>{fmt(r.calls)}</TableCell>
                    <TableCell>{fmt(r.tokens)}</TableCell>
                    <TableCell>{fmtCost(r.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* By Skill */}
      {usage && usage.bySkill.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Usage by Skill</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Skill</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.bySkill.map((r) => (
                  <TableRow key={r.skill}>
                    <TableCell className="font-mono text-sm">{r.skill}</TableCell>
                    <TableCell>{fmt(r.calls)}</TableCell>
                    <TableCell>{fmt(r.tokens)}</TableCell>
                    <TableCell>{fmtCost(r.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {(!usage || (parseInt(usage.summary.total_calls) === 0)) && (
        <Card>
          <CardContent className="py-8 text-center text-zinc-400">
            No usage this month. Usage is tracked when your AI skills run.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
