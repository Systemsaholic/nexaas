"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, Plus, Sparkles, Send } from "lucide-react";

const CATEGORIES = ["msp", "finance", "marketing", "hr", "operations", "sales", "custom"];

export default function NewSkillPage() {
  const router = useRouter();

  // Form mode state
  const [category, setCategory] = useState("msp");
  const [name, setName] = useState("");
  const [type, setType] = useState<"simple" | "agentic">("simple");
  const [description, setDescription] = useState("");
  const [mcpServers, setMcpServers] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI mode state
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResponse, setAiResponse] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiParsed, setAiParsed] = useState<{
    category?: string; name?: string; type?: string; description?: string; mcpServers?: string[];
  } | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/skills/packages/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          name,
          type,
          description,
          mcpServers: mcpServers ? mcpServers.split(",").map((s) => s.trim()) : [],
        }),
      });
      const json = await res.json();

      if (json.ok) {
        router.push(`/admin/skills/${json.data.id.replace("/", "--")}`);
      } else {
        setError(json.error ?? "Failed to create skill");
        setCreating(false);
      }
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiResponse(null);
    setAiParsed(null);

    try {
      const res = await fetch("/api/v1/skills/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `I want to create a new skill. Here's what it should do:\n\n${aiPrompt}\n\nBased on this description, suggest:\n1. A good category (one of: msp, finance, marketing, hr, operations, sales, custom)\n2. A kebab-case name\n3. Whether it should be "simple" (single API call) or "agentic" (multi-step with tools)\n4. A one-line description\n5. Which MCP servers it needs\n\nRespond in this exact JSON format (no other text):\n{"category": "...", "name": "...", "type": "simple|agentic", "description": "...", "mcpServers": ["..."]}`,
        }),
      });
      const json = await res.json();

      if (json.ok) {
        const text = json.data.response;
        setAiResponse(text);

        // Try to parse JSON from response
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            setAiParsed(parsed);
            // Pre-fill form
            if (parsed.category) setCategory(parsed.category);
            if (parsed.name) setName(parsed.name);
            if (parsed.type) setType(parsed.type);
            if (parsed.description) setDescription(parsed.description);
            if (parsed.mcpServers) setMcpServers(parsed.mcpServers.join(", "));
          }
        } catch { /* response wasn't pure JSON, show raw */ }
      } else {
        setAiResponse(`Error: ${json.error}`);
      }
    } catch (e) {
      setAiResponse(`Error: ${(e as Error).message}`);
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/skills"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <h1 className="text-2xl font-bold">Create Skill Package</h1>
      </div>

      <Tabs defaultValue="ai">
        <TabsList className="mb-4">
          <TabsTrigger value="ai"><Sparkles className="h-4 w-4 mr-1" /> AI-Assisted</TabsTrigger>
          <TabsTrigger value="manual"><Plus className="h-4 w-4 mr-1" /> Manual</TabsTrigger>
        </TabsList>

        {/* AI-Assisted Mode */}
        <TabsContent value="ai">
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-purple-500" />
                Describe your skill
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="Describe what the skill should do in plain language. For example:&#10;&#10;'I need a skill that monitors incoming emails, classifies them by type (billing, support, sales, spam), drafts appropriate responses for routine queries, and escalates complex issues to the right team member. It should work with Gmail or IMAP.'"
                className="w-full h-32 rounded-md border bg-zinc-950 p-3 text-sm text-zinc-300 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <Button
                onClick={handleAiGenerate}
                disabled={!aiPrompt.trim() || aiLoading}
                className="bg-purple-600 hover:bg-purple-700"
              >
                <Sparkles className="h-4 w-4 mr-2" />
                {aiLoading ? "Generating..." : "Generate Skill Definition"}
              </Button>

              {aiResponse && !aiParsed && (
                <ScrollArea className="h-48 rounded-md border bg-zinc-950 p-3">
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap">{aiResponse}</pre>
                </ScrollArea>
              )}

              {aiParsed && (
                <div className="rounded-md border bg-green-50 p-4 space-y-2 dark:bg-green-950">
                  <p className="text-sm font-medium text-green-800 dark:text-green-200">AI suggests:</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-zinc-500">Category:</span> <Badge variant="secondary">{aiParsed.category}</Badge></div>
                    <div><span className="text-zinc-500">Name:</span> <code className="text-xs bg-zinc-100 px-1 rounded dark:bg-zinc-800">{aiParsed.name}</code></div>
                    <div><span className="text-zinc-500">Type:</span> <Badge variant={aiParsed.type === "agentic" ? "default" : "secondary"}>{aiParsed.type}</Badge></div>
                    <div><span className="text-zinc-500">MCP:</span> {aiParsed.mcpServers?.join(", ") || "none"}</div>
                  </div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{aiParsed.description}</p>
                  <p className="text-xs text-green-600 dark:text-green-400">Form below has been pre-filled. Review and click "Create" to generate the package.</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Form pre-filled by AI, same as manual */}
          <SkillForm
            category={category} setCategory={setCategory}
            name={name} setName={setName}
            type={type} setType={setType}
            description={description} setDescription={setDescription}
            mcpServers={mcpServers} setMcpServers={setMcpServers}
            creating={creating} error={error}
            onSubmit={handleCreate}
          />
        </TabsContent>

        {/* Manual Mode */}
        <TabsContent value="manual">
          <SkillForm
            category={category} setCategory={setCategory}
            name={name} setName={setName}
            type={type} setType={setType}
            description={description} setDescription={setDescription}
            mcpServers={mcpServers} setMcpServers={setMcpServers}
            creating={creating} error={error}
            onSubmit={handleCreate}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SkillForm({
  category, setCategory, name, setName, type, setType,
  description, setDescription, mcpServers, setMcpServers,
  creating, error, onSubmit,
}: {
  category: string; setCategory: (v: string) => void;
  name: string; setName: (v: string) => void;
  type: "simple" | "agentic"; setType: (v: "simple" | "agentic") => void;
  description: string; setDescription: (v: string) => void;
  mcpServers: string; setMcpServers: (v: string) => void;
  creating: boolean; error: string | null;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Skill Definition</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Category</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button key={cat} type="button" onClick={() => setCategory(cat)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    category === cat ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
                  }`}>{cat}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Skill Name</label>
            <Input placeholder="e.g. email-triage" value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} required />
            <p className="text-xs text-zinc-400 mt-1">ID: {category}/{name || "..."}</p>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Execution Type</label>
            <div className="grid grid-cols-2 gap-3">
              {(["simple", "agentic"] as const).map((t) => (
                <label key={t} className={`flex flex-col rounded-lg border p-3 cursor-pointer transition-colors ${
                  type === t ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                }`}>
                  <div className="flex items-center gap-2">
                    <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="accent-zinc-900" />
                    <span className="text-sm font-medium capitalize">{t}</span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      t === "agentic" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                    }`}>{t}</span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-1">
                    {t === "simple" ? "Single Claude API call. Classification, triage, drafting." : "Multi-step with tools. Pipelines, reconciliation."}
                  </p>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">Description</label>
            <Input placeholder="What does this skill do?" value={description} onChange={(e) => setDescription(e.target.value)} required />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">MCP Servers (optional)</label>
            <Input placeholder="e.g. email, filesystem, quickbooks" value={mcpServers} onChange={(e) => setMcpServers(e.target.value)} />
          </div>

          {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <Button type="submit" disabled={creating || !name || !description} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            {creating ? "Creating..." : "Create Skill Package"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
