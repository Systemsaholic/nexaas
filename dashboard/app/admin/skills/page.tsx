"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import type { SkillProposal, FeedbackSignal } from "@/lib/types";

export default function SkillsPage() {
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [feedback, setFeedback] = useState<FeedbackSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<number | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const [pRes, fRes] = await Promise.all([
        fetch("/api/v1/skills/proposals"),
        fetch("/api/v1/skills/feedback"),
      ]);
      const [pJson, fJson] = await Promise.all([pRes.json(), fRes.json()]);
      if (pJson.ok) setProposals(pJson.data);
      if (fJson.ok) setFeedback(fJson.data);
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(proposalId: number, action: "approve" | "reject") {
    setActing(proposalId);
    try {
      await fetch(`/api/v1/skills/proposals/${proposalId}`, {
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

  const pending = proposals.filter((p) => p.status === "pending");
  const resolved = proposals.filter((p) => p.status !== "pending");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Skill Pipeline</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {pending.length} pending proposals, {feedback.length} feedback signals
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Tabs defaultValue="proposals">
        <TabsList>
          <TabsTrigger value="proposals">
            Proposals {pending.length > 0 && <Badge variant="secondary" className="ml-2">{pending.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="feedback">Feedback</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="proposals" className="mt-4">
          {pending.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-zinc-400">
                No pending proposals.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Skill</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Improvement</TableHead>
                    <TableHead>Clean</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-sm">{p.skill_id}</TableCell>
                      <TableCell>
                        <span className="text-zinc-500">{p.from_version}</span>
                        {" -> "}
                        <span className="font-medium">{p.proposed_version}</span>
                      </TableCell>
                      <TableCell>{p.workspace_id}</TableCell>
                      <TableCell className="max-w-xs truncate">{p.proposed_improvement}</TableCell>
                      <TableCell>
                        {p.pass1_clean ? (
                          <Badge variant="default">Clean</Badge>
                        ) : (
                          <Badge variant="destructive">Flagged</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleAction(p.id, "approve")}
                            disabled={acting === p.id}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleAction(p.id, "reject")}
                            disabled={acting === p.id}
                          >
                            <XCircle className="h-3 w-3 mr-1" /> Reject
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="feedback" className="mt-4">
          {feedback.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-zinc-400">
                No feedback signals captured yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Signal</TableHead>
                    <TableHead>Skill</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Reflection</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedback.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>
                        <Badge variant={f.signal === "skill_improvement" ? "default" : "destructive"}>
                          {f.signal}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-sm">{f.skill_id}</TableCell>
                      <TableCell>{f.workspace_id}</TableCell>
                      <TableCell className="max-w-xs truncate">{f.claude_reflection ?? "-"}</TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {new Date(f.created_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {resolved.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-zinc-400">
                No resolved proposals yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Skill</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reviewed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resolved.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono text-sm">{p.skill_id}</TableCell>
                      <TableCell>{p.from_version} -&gt; {p.proposed_version}</TableCell>
                      <TableCell>
                        <Badge variant={p.status === "deployed" ? "default" : p.status === "rejected" ? "destructive" : "secondary"}>
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-zinc-500 text-sm">
                        {p.reviewed_at ? new Date(p.reviewed_at).toLocaleDateString() : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
