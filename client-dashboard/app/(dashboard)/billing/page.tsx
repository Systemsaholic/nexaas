"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSign, Zap, Cpu, BarChart3 } from "lucide-react";

interface UsageSummary {
  total_calls: number;
  total_tokens: number;
  total_cost: number;
}

export default function BillingPage() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    fetch("/api/dashboard/stats").then((r) => r.json()).then((j) => {
      if (j.ok) {
        setUsage({
          total_calls: 0,
          total_tokens: j.data.tokensThisMonth ?? 0,
          total_cost: 0,
        });
      }
    });
  }, []);

  const formatTokens = (t: number) => t >= 1000000 ? `${(t / 1000000).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(0)}K` : String(t);

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="text-sm text-zinc-500 mt-1">Your plan and usage</p>
      </div>

      {/* Usage Summary */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Cpu className="h-4 w-4 text-blue-500" /><span className="text-sm">Tokens This Month</span></div>
            <p className="text-2xl font-bold">{usage ? formatTokens(usage.total_tokens) : "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><Zap className="h-4 w-4 text-yellow-500" /><span className="text-sm">API Calls</span></div>
            <p className="text-2xl font-bold">{usage?.total_calls ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 mb-1"><DollarSign className="h-4 w-4 text-green-500" /><span className="text-sm">Estimated Cost</span></div>
            <p className="text-2xl font-bold">${usage ? usage.total_cost.toFixed(2) : "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Plan Info */}
      <Card>
        <CardHeader><CardTitle className="text-base">Current Plan</CardTitle></CardHeader>
        <CardContent className="text-sm text-zinc-500">
          <p>Stripe billing integration coming soon. Your usage is being tracked and will be reflected once billing is configured.</p>
        </CardContent>
      </Card>
    </div>
  );
}
