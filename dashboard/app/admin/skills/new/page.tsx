"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus } from "lucide-react";

const CATEGORIES = ["msp", "finance", "marketing", "hr", "operations", "sales", "custom"];

export default function NewSkillPage() {
  const router = useRouter();
  const [category, setCategory] = useState("msp");
  const [name, setName] = useState("");
  const [type, setType] = useState<"simple" | "agentic">("simple");
  const [description, setDescription] = useState("");
  const [mcpServers, setMcpServers] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="max-w-lg">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/admin/skills"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button></Link>
        <h1 className="text-2xl font-bold">Create Skill Package</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Skill Definition</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Category</label>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      category === cat
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Skill Name</label>
              <Input
                placeholder="e.g. email-triage, invoice-reminders"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                required
              />
              <p className="text-xs text-zinc-400 mt-1">Lowercase, hyphens only. ID will be: {category}/{name || "..."}</p>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Execution Type</label>
              <div className="grid grid-cols-2 gap-3">
                {(["simple", "agentic"] as const).map((t) => (
                  <label
                    key={t}
                    className={`flex flex-col rounded-lg border p-3 cursor-pointer transition-colors ${
                      type === t
                        ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
                        : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} className="accent-zinc-900" />
                      <span className="text-sm font-medium capitalize">{t}</span>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        t === "agentic" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                      }`}>{t}</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-1">
                      {t === "simple"
                        ? "Single Claude API call. Fast, cheap. Classification, triage, drafting."
                        : "Multi-step with tools. Claude calls MCP servers in a loop. Pipelines, reconciliation."}
                    </p>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Input
                placeholder="What does this skill do?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">MCP Servers (optional)</label>
              <Input
                placeholder="e.g. email, filesystem, quickbooks"
                value={mcpServers}
                onChange={(e) => setMcpServers(e.target.value)}
              />
              <p className="text-xs text-zinc-400 mt-1">Comma-separated list of required MCP servers.</p>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
            )}

            <Button type="submit" disabled={creating || !name || !description} className="w-full">
              <Plus className="h-4 w-4 mr-2" />
              {creating ? "Creating..." : "Create Skill Package"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-zinc-400 mt-4">
        This creates a skill package from the template with contract, prompt, TAG routes,
        onboarding questions, and RAG config. Edit the generated files to customize.
      </p>
    </div>
  );
}
