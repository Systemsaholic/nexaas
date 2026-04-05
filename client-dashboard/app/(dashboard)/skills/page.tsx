"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  RefreshCw, CheckCircle2, AlertCircle, Zap, Brain, Shield, BookOpen,
  ThumbsUp, ThumbsDown, MessageSquare, Upload, Sliders, Send, Check, X, FileText,
} from "lucide-react";

interface ClientSkill {
  id: string;
  name: string;
  category: string;
  active: boolean;
  version: string;
  type: "simple" | "agentic";
  description: string;
  configured: boolean;
  missingConfig: string[];
  features: string[];
}

interface ActivityEntry {
  id: number;
  skill_id: string | null;
  action: string;
  summary: string;
  tag_route: string | null;
  created_at: string;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<ClientSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<ClientSkill | null>(null);

  async function fetchSkills() {
    setLoading(true);
    try {
      const res = await fetch("/api/skills");
      const json = await res.json();
      if (json.ok) setSkills(json.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchSkills(); }, []);

  if (selectedSkill) {
    return <SkillDetail skill={selectedSkill} onBack={() => setSelectedSkill(null)} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AI Skills</h1>
          <p className="text-sm text-zinc-500 mt-1">Manage and improve how your AI works</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSkills} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {skills.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Zap className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium mb-2">No skills installed yet</h3>
            <p className="text-sm text-zinc-500">Your AI skills are being set up by your admin.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {skills.map((skill) => (
          <Card
            key={skill.id}
            className={`cursor-pointer transition-shadow hover:shadow-md ${skill.active ? "border-green-200 dark:border-green-900" : ""}`}
            onClick={() => setSelectedSkill(skill)}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{skill.name}</CardTitle>
                {skill.active ? (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                    <CheckCircle2 className="h-3 w-3" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700">
                    <AlertCircle className="h-3 w-3" /> Setup needed
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-500 mb-3">{skill.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {skill.features.slice(0, 3).map((f) => (
                  <span key={f} className="inline-flex items-center rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{f}</span>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Skill Detail with Honing Tools ─────────────────────────────────────

function SkillDetail({ skill, onBack }: { skill: ClientSkill; onBack: () => void }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
        <div>
          <h1 className="text-2xl font-bold">{skill.name}</h1>
          <p className="text-sm text-zinc-500">{skill.description}</p>
        </div>
      </div>

      <Tabs defaultValue="feedback">
        <TabsList>
          <TabsTrigger value="feedback"><ThumbsUp className="h-4 w-4 mr-1" /> Feedback</TabsTrigger>
          <TabsTrigger value="rules"><MessageSquare className="h-4 w-4 mr-1" /> Custom Rules</TabsTrigger>
          <TabsTrigger value="preferences"><Sliders className="h-4 w-4 mr-1" /> Preferences</TabsTrigger>
          <TabsTrigger value="knowledge"><BookOpen className="h-4 w-4 mr-1" /> Knowledge</TabsTrigger>
        </TabsList>

        <TabsContent value="feedback" className="mt-4">
          <FeedbackPanel skillId={skill.id} />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <RulesPanel skillId={skill.id} />
        </TabsContent>
        <TabsContent value="preferences" className="mt-4">
          <PreferencesPanel skillId={skill.id} />
        </TabsContent>
        <TabsContent value="knowledge" className="mt-4">
          <KnowledgePanel skillId={skill.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Feedback Panel ─────────────────────────────────────────────────────

function FeedbackPanel({ skillId }: { skillId: string }) {
  const encodedId = skillId.replace("/", "--");
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [feedbackGiven, setFeedbackGiven] = useState<Set<number>>(new Set());
  const [commentId, setCommentId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/activity?limit=20`).then((r) => r.json()).then((j) => {
      if (j.ok) setActivity(j.data.filter((a: ActivityEntry) => a.skill_id === skillId));
    });
  }, [skillId]);

  async function submitFeedback(activityId: number, rating: "positive" | "negative", feedbackComment?: string) {
    try {
      const res = await fetch(`/api/skills/${encodedId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityId, rating, comment: feedbackComment }),
      });
      const json = await res.json();
      if (json.ok) {
        setFeedbackGiven((prev) => new Set([...prev, activityId]));
        setMessage("Thanks for the feedback!");
        setCommentId(null);
        setComment("");
      }
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">Rate how well this skill performed. Your feedback helps it improve.</p>

      {message && <div className="rounded-md bg-green-50 p-2 text-sm text-green-700">{message}</div>}

      {activity.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-zinc-400">No recent activity for this skill yet.</CardContent></Card>
      ) : (
        <div className="space-y-2">
          {activity.map((a) => (
            <Card key={a.id}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm">{a.summary}</p>
                    <p className="text-xs text-zinc-400 mt-1">{new Date(a.created_at).toLocaleString()}</p>
                  </div>
                  {!feedbackGiven.has(a.id) ? (
                    <div className="flex gap-1 ml-3">
                      <Button size="sm" variant="ghost" onClick={() => submitFeedback(a.id, "positive")} className="text-green-600 hover:bg-green-50">
                        <ThumbsUp className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setCommentId(commentId === a.id ? null : a.id)} className="text-red-500 hover:bg-red-50">
                        <ThumbsDown className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> Feedback sent</span>
                  )}
                </div>
                {commentId === a.id && (
                  <div className="mt-3 flex gap-2">
                    <Input
                      placeholder="What was wrong? (optional)"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      className="text-sm"
                    />
                    <Button size="sm" onClick={() => submitFeedback(a.id, "negative", comment)}>
                      <Send className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Rules Panel (AI-powered) ───────────────────────────────────────────

function RulesPanel({ skillId }: { skillId: string }) {
  const encodedId = skillId.replace("/", "--");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [proposal, setProposal] = useState<{ explanation: string; proposedRules: string } | null>(null);
  const [currentRules, setCurrentRules] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/skills/${encodedId}/rules`).then((r) => r.json()).then((j) => {
      if (j.ok) setCurrentRules(j.data.rules);
    });
  }, [encodedId]);

  async function askAI() {
    if (!input.trim()) return;
    setLoading(true);
    setProposal(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${encodedId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });
      const json = await res.json();
      if (json.ok && json.data.proposedRules) {
        setProposal(json.data);
      } else {
        setMessage(json.data?.explanation || json.error || "Could not create a rule from that.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function applyRule() {
    if (!proposal?.proposedRules) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/skills/${encodedId}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "", confirm: proposal.proposedRules }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage("Rule applied!");
        setCurrentRules(proposal.proposedRules);
        setProposal(null);
        setInput("");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">Tell the AI how you want this skill to behave differently. It will create a rule for you.</p>

      {/* Input */}
      <div className="flex gap-2">
        <Input
          placeholder='e.g. "Never auto-reply on weekends" or "Always escalate emails from contractors"'
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && askAI()}
          disabled={loading}
        />
        <Button onClick={askAI} disabled={!input.trim() || loading}>
          {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      {message && <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-700">{message}</div>}

      {/* Proposal */}
      {proposal && (
        <Card className="border-purple-300 dark:border-purple-800">
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm">{proposal.explanation}</p>
            <pre className="rounded-md bg-zinc-900 p-3 text-xs text-zinc-200 font-mono overflow-x-auto max-h-48 overflow-y-auto">
              {proposal.proposedRules}
            </pre>
            <div className="flex gap-2">
              <Button size="sm" onClick={applyRule} disabled={loading}>
                <Check className="h-3 w-3 mr-1" /> Apply Rule
              </Button>
              <Button size="sm" variant="outline" onClick={() => setProposal(null)}>
                <X className="h-3 w-3 mr-1" /> Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Current Rules */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Current Custom Rules</CardTitle></CardHeader>
        <CardContent>
          <pre className="rounded-md bg-zinc-50 p-3 text-xs text-zinc-600 font-mono dark:bg-zinc-900 dark:text-zinc-400 overflow-x-auto">
            {currentRules || "No custom rules yet."}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Preferences Panel ──────────────────────────────────────────────────

function PreferencesPanel({ skillId }: { skillId: string }) {
  const encodedId = skillId.replace("/", "--");
  const [config, setConfig] = useState<Record<string, any> | null>(null);
  const [questions, setQuestions] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/skills/${encodedId}/preferences`).then((r) => r.json()).then((j) => {
      if (j.ok) {
        setConfig(j.data.config);
        setQuestions(j.data.questions);
      }
    });
  }, [encodedId]);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/skills/${encodedId}/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const json = await res.json();
      setMessage(json.ok ? "Preferences saved!" : `Error: ${json.error}`);
    } finally {
      setSaving(false);
    }
  }

  if (!config && questions.length === 0) {
    return <p className="text-sm text-zinc-400">No configurable preferences for this skill.</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">Adjust how this skill behaves for your business.</p>

      {questions.map((q: any) => (
        <div key={q.id} className="space-y-1">
          <label className="text-sm font-medium">{q.question}</label>
          {q.options ? (
            <div className="space-y-1">
              {q.options.map((opt: any, i: number) => (
                <label key={i} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    checked={getNestedValue(config, q.maps_to) === opt.value}
                    onChange={() => setConfig(setNestedValue({ ...config }, q.maps_to, opt.value))}
                    className="accent-zinc-900"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          ) : (
            <Input
              value={String(getNestedValue(config, q.maps_to) ?? "")}
              onChange={(e) => setConfig(setNestedValue({ ...config }, q.maps_to, e.target.value))}
              placeholder={q.examples?.[0] ?? ""}
            />
          )}
        </div>
      ))}

      {message && <p className={`text-sm ${message.startsWith("Error") ? "text-red-500" : "text-green-600"}`}>{message}</p>}

      <Button onClick={save} disabled={saving}>
        <Check className="h-4 w-4 mr-2" /> {saving ? "Saving..." : "Save Preferences"}
      </Button>
    </div>
  );
}

// ── Knowledge Panel ────────────────────────────────────────────────────

function KnowledgePanel({ skillId }: { skillId: string }) {
  const encodedId = skillId.replace("/", "--");
  const [docs, setDocs] = useState<Array<{ name: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/skills/${encodedId}/knowledge`).then((r) => r.json()).then((j) => {
      if (j.ok) setDocs(j.data);
    });
  }, [encodedId]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/skills/${encodedId}/knowledge`, { method: "POST", body: formData });
      const json = await res.json();
      setMessage(json.ok ? `Uploaded ${file.name}` : `Error: ${json.error}`);
      // Refresh list
      const listRes = await fetch(`/api/skills/${encodedId}/knowledge`);
      const listJson = await listRes.json();
      if (listJson.ok) setDocs(listJson.data);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function deleteDoc(fileName: string) {
    if (!confirm(`Delete ${fileName}?`)) return;
    await fetch(`/api/skills/${encodedId}/knowledge`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName }),
    });
    setDocs((prev) => prev.filter((d) => d.name !== fileName));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        Upload your policies, SOPs, and FAQs. The AI will reference these when running this skill.
      </p>

      {/* Upload */}
      <div>
        <label className="inline-flex items-center gap-2 rounded-md border border-dashed border-zinc-300 px-4 py-3 cursor-pointer hover:bg-zinc-50 transition-colors dark:border-zinc-700 dark:hover:bg-zinc-900">
          <Upload className="h-4 w-4 text-zinc-400" />
          <span className="text-sm text-zinc-500">{uploading ? "Uploading..." : "Upload a document (PDF, TXT, MD)"}</span>
          <input type="file" className="hidden" accept=".pdf,.txt,.md,.doc,.docx" onChange={handleUpload} disabled={uploading} />
        </label>
      </div>

      {message && <div className="rounded-md bg-green-50 p-2 text-sm text-green-700">{message}</div>}

      {/* Document List */}
      {docs.length === 0 ? (
        <p className="text-sm text-zinc-400">No documents uploaded yet.</p>
      ) : (
        <div className="space-y-2">
          {docs.map((doc) => (
            <div key={doc.name} className="flex items-center justify-between rounded-md border p-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-zinc-400" />
                <span className="text-sm">{doc.name}</span>
              </div>
              <Button variant="ghost" size="sm" className="text-red-500 text-xs" onClick={() => deleteDoc(doc.name)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getNestedValue(obj: any, path: string): unknown {
  if (!obj) return undefined;
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: unknown): any {
  const copy = { ...obj };
  const parts = path.split(".");
  let current = copy;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]] || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
  return copy;
}
