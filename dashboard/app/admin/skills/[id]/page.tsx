"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { SkillCopilot } from "@/components/skill-copilot";
import { ArrowLeft, Save, FileText, History, Sparkles } from "lucide-react";

interface SkillDetail {
  id: string;
  category: string;
  name: string;
  version: string;
  type: "simple" | "agentic";
  status: string;
  description: string;
  files: string[];
  fileContents: Record<string, string>;
  contract?: Record<string, unknown>;
}

interface GitEntry {
  hash: string;
  hashShort: string;
  author: string;
  date: string;
  message: string;
}

export default function SkillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const skillId = (id as string).replace("--", "/");
  const [data, setData] = useState<SkillDetail | null>(null);
  const [history, setHistory] = useState<GitEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function fetchData() {
    setLoading(true);
    try {
      const [pkgRes, histRes] = await Promise.all([
        fetch(`/api/v1/skills/packages/${id}`),
        fetch(`/api/v1/skills/packages/${id}/history`),
      ]);
      const [pkgJson, histJson] = await Promise.all([pkgRes.json(), histRes.json()]);
      if (pkgJson.ok) {
        setData(pkgJson.data);
        if (!activeFile && pkgJson.data.files.length > 0) {
          const defaultFile = pkgJson.data.files.includes("contract.yaml") ? "contract.yaml" : pkgJson.data.files[0];
          setActiveFile(defaultFile);
          setEditContent(pkgJson.data.fileContents[defaultFile] ?? "");
        }
      }
      if (histJson.ok) setHistory(histJson.data);
    } finally {
      setLoading(false);
    }
  }

  function selectFile(file: string) {
    setActiveFile(file);
    setEditContent(data?.fileContents[file] ?? "");
    setMessage(null);
  }

  async function saveFile() {
    if (!activeFile) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/skills/packages/${id}/${activeFile}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      const json = await res.json();
      if (json.ok) {
        setMessage(`Saved and committed: ${activeFile}`);
        fetchData(); // Refresh to get updated history
      } else {
        setMessage(`Error: ${json.error}`);
      }
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { fetchData(); }, [id]);

  if (loading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-96" /></div>;
  }

  if (!data) {
    return <p className="text-zinc-500">Skill package not found.</p>;
  }

  const fileOrder = ["contract.yaml", "onboarding-questions.yaml", "system-prompt.hbs", "tag-routes.yaml", "rag-config.yaml", "CHANGELOG.md"];
  const sortedFiles = [...data.files].sort((a, b) => {
    const ai = fileOrder.indexOf(a);
    const bi = fileOrder.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/skills"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{data.name}</h1>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                data.type === "agentic" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
              }`}>{data.type}</span>
              <Badge variant={data.status === "active" ? "default" : "secondary"}>{data.status}</Badge>
              <span className="text-sm text-zinc-400">v{data.version}</span>
            </div>
            <p className="text-sm text-zinc-500 mt-1">{data.description}</p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="editor">
        <TabsList>
          <TabsTrigger value="editor"><FileText className="h-4 w-4 mr-1" /> Editor</TabsTrigger>
          <TabsTrigger value="history"><History className="h-4 w-4 mr-1" /> History ({history.length})</TabsTrigger>
        </TabsList>

        {/* Editor Tab */}
        <TabsContent value="editor" className="mt-4">
          <div className="grid grid-cols-[200px_1fr_350px] gap-4">
            {/* File list */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Files</CardTitle></CardHeader>
              <CardContent className="p-2">
                {sortedFiles.map((file) => (
                  <button
                    key={file}
                    onClick={() => selectFile(file)}
                    className={`w-full text-left rounded-md px-2 py-1.5 text-xs font-mono transition-colors ${
                      activeFile === file
                        ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                        : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {file}
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Editor */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-mono">{activeFile}</CardTitle>
                <Button size="sm" onClick={saveFile} disabled={saving || !activeFile}>
                  <Save className="h-3 w-3 mr-1" />
                  {saving ? "Saving..." : "Save & Commit"}
                </Button>
              </CardHeader>
              <CardContent>
                {message && (
                  <div className={`rounded-md p-2 mb-2 text-xs ${message.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
                    {message}
                  </div>
                )}
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-[500px] rounded-md border bg-zinc-950 p-3 text-xs text-zinc-300 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-zinc-600"
                  spellCheck={false}
                />
              </CardContent>
            </Card>

            {/* AI Copilot */}
            <div className="h-[600px]">
              <SkillCopilot
                skillId={data.id}
                activeFile={activeFile ?? undefined}
                fileContent={editContent}
                onApplyCode={(code) => setEditContent(code)}
              />
            </div>
          </div>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="mt-4">
          {history.length === 0 ? (
            <Card><CardContent className="py-8 text-center text-zinc-400">No git history for this skill.</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="pt-4">
                <div className="space-y-2">
                  {history.map((entry) => (
                    <div key={entry.hash} className="flex items-start gap-3 rounded-md border p-3">
                      <code className="text-xs bg-zinc-100 px-1.5 py-0.5 rounded dark:bg-zinc-800">{entry.hashShort}</code>
                      <div className="flex-1">
                        <p className="text-sm">{entry.message}</p>
                        <p className="text-xs text-zinc-400 mt-0.5">{entry.author} — {new Date(entry.date).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
