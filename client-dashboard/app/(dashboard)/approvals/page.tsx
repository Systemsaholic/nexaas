"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, XCircle, Clock, RefreshCw } from "lucide-react";

interface Approval {
  id: number;
  skill_id: string | null;
  action_type: string;
  summary: string;
  details: Record<string, unknown>;
  status: string;
  created_at: string;
  responded_at: string | null;
  expires_at: string | null;
}

export default function ApprovalsPage() {
  const [pending, setPending] = useState<Approval[]>([]);
  const [history, setHistory] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<number | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const [pRes, hRes] = await Promise.all([
        fetch("/api/approvals?status=pending"),
        fetch("/api/approvals?status=approved"),
      ]);
      const [pJson, hJson] = await Promise.all([pRes.json(), hRes.json()]);
      if (pJson.ok) setPending(pJson.data);
      if (hJson.ok) setHistory(hJson.data);
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(id: number, action: "approve" | "reject") {
    setActing(id);
    try {
      await fetch(`/api/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      fetchData();
    } finally {
      setActing(null);
    }
  }

  useEffect(() => { fetchData(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="text-sm text-zinc-500 mt-1">{pending.length} pending</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">
            Pending {pending.length > 0 && <Badge variant="secondary" className="ml-1">{pending.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4 space-y-3">
          {pending.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-zinc-400">No pending approvals. Your AI is handling everything within your rules.</CardContent></Card>
          ) : (
            pending.map((a) => (
              <Card key={a.id}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <Clock className="h-4 w-4 text-yellow-500" />
                        <span className="text-sm font-medium">{a.summary}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <span>{a.action_type}</span>
                        {a.skill_id && <><span>•</span><span className="font-mono">{a.skill_id}</span></>}
                        <span>•</span>
                        <span>{new Date(a.created_at).toLocaleString()}</span>
                      </div>
                      {(a.details as any)?.draftReply && (
                        <div className="mt-2 rounded-md bg-zinc-50 p-3 text-sm text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                          {String((a.details as any).draftReply).slice(0, 300)}
                          {String((a.details as any).draftReply).length > 300 && "..."}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2 ml-4">
                      <Button size="sm" onClick={() => handleAction(a.id, "approve")} disabled={acting === a.id}>
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => handleAction(a.id, "reject")} disabled={acting === a.id}>
                        <XCircle className="h-4 w-4 mr-1" /> Reject
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-2">
          {history.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-zinc-400">No approval history yet.</CardContent></Card>
          ) : (
            history.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-zinc-400">{new Date(a.created_at).toLocaleString()}</p>
                </div>
                <Badge variant={a.status === "approved" ? "default" : "destructive"}>{a.status}</Badge>
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
