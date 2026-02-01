"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useAgentStream } from "@/lib/hooks/use-agent-stream";
import { toast } from "sonner";
import { SparklesIcon, SaveIcon, SendIcon, SearchIcon, AlertCircleIcon } from "lucide-react";
import dynamic from "next/dynamic";

const RichEditor = dynamic(
  () => import("@/components/ui/rich-editor").then((m) => ({ default: m.RichEditor })),
  { ssr: false, loading: () => <Skeleton className="h-[400px] w-full" /> }
);

interface ContentDraft {
  title: string;
  type: string;
  client: string;
  status: string;
  author: string;
  word_count: string;
  body?: string;
}

interface RegistryData {
  name: string;
  data: {
    fields: { name: string; type: string }[];
    entries: ContentDraft[];
  };
}

interface ContentEditorConfig {
  registry?: string;
  [key: string]: unknown;
}

const statusBadge: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-600",
  "in review": "bg-yellow-500/15 text-yellow-700",
  published: "bg-emerald-500/15 text-emerald-700",
  revision: "bg-orange-500/15 text-orange-700",
};

export default function ContentEditor({
  config,
  title,
}: {
  config: ContentEditorConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveGatewayClient());
  const [drafts, setDrafts] = useState<ContentDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [editContent, setEditContent] = useState("");

  const rewrite = useAgentStream();
  const seo = useAgentStream();
  const aiLoading = rewrite.status === "streaming" || rewrite.status === "connecting" ||
                    seo.status === "streaming" || seo.status === "connecting";

  const registryName = config.registry ?? "content-drafts";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getRegistry(registryName)
      .then((data) => {
        if (!cancelled) {
          const rd = data as unknown as RegistryData;
          const entries = rd?.data?.entries ?? [];
          setDrafts(entries);
          if (entries.length > 0) {
            setEditContent(entries[0].body ?? `<p>Content for "${entries[0].title}"</p><p>Start editing this ${entries[0].type} here...</p>`);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load content drafts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, registryName]);

  const draft = drafts[selected];

  const selectDraft = (i: number) => {
    setSelected(i);
    const d = drafts[i];
    setEditContent(d.body ?? `<p>Content for "${d.title}"</p><p>Start editing this ${d.type} here...</p>`);
  };

  const handleSave = () => {
    toast.success(`"${draft?.title}" saved`);
  };

  const handleSubmitReview = () => {
    if (draft) {
      setDrafts((prev) =>
        prev.map((d, i) => (i === selected ? { ...d, status: "in review" } : d))
      );
      toast.success(`"${draft.title}" submitted for review`);
    }
  };

  const handleAiRewrite = useCallback((content: string) => {
    toast.info("AI rewriting content...", { description: "content-writer agent: Processing..." });
    rewrite.fire("content-writer", `Improve and rewrite this content for better readability and engagement: "${content.replace(/<[^>]*>/g, "").slice(0, 500)}"`);
  }, [draft, rewrite]);

  useEffect(() => {
    if (rewrite.status === "done" && rewrite.response) {
      setEditContent((prev) => prev + `<p><br/></p><p><em>${rewrite.response.slice(0, 500)}</em></p>`);
      toast.success("AI rewrite complete");
    }
  }, [rewrite.status, rewrite.response]);

  const handleGenerateSeo = () => {
    toast.info("Generating SEO meta...", { description: "analytics agent: Analyzing content for SEO..." });
    seo.fire("analytics", `Generate SEO meta tags (title tag, meta description, keywords) for: "${draft?.title}"`);
  };

  useEffect(() => {
    if (seo.status === "done") {
      toast.success("SEO meta generated", {
        description: `Title tag, meta description, and keyword suggestions ready for "${draft?.title}"`,
      });
    }
  }, [seo.status, draft?.title]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Content Editor"}</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          <Skeleton className="h-[500px] w-[250px]" />
          <Skeleton className="h-[500px] flex-1" />
        </CardContent>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Content Editor"}</CardTitle>
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Content Editor"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row">
        {/* Left: content list */}
        <ScrollArea className="h-[520px] w-full shrink-0 rounded-md border sm:w-[260px]">
          <div className="flex flex-col">
            {drafts.map((d, i) => (
              <button
                key={i}
                onClick={() => selectDraft(i)}
                className={`flex flex-col gap-1 border-b px-3 py-3 text-left transition-colors last:border-0 ${
                  i === selected ? "bg-primary/[0.06]" : "hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{d.title}</span>
                  {i === selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{d.type} · {d.client}</span>
                  <Badge variant="secondary" className={`ml-auto shrink-0 text-[10px] ${statusBadge[d.status] ?? ""}`}>
                    {d.status}
                  </Badge>
                </div>
              </button>
            ))}
            {drafts.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No content drafts.</p>
            )}
          </div>
        </ScrollArea>

        {/* Right: rich text editor */}
        {draft ? (
          <div className="flex flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{draft.title}</h3>
                <p className="text-xs text-muted-foreground">{draft.type} · {draft.client} · {draft.word_count} words · {draft.author}</p>
              </div>
              <Badge variant="secondary" className={`text-xs ${statusBadge[draft.status] ?? ""}`}>
                {draft.status}
              </Badge>
            </div>

            <Separator />

            <RichEditor
              content={editContent}
              onChange={setEditContent}
              placeholder="Start writing..."
              onAiImprove={handleAiRewrite}
              aiLoading={aiLoading}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={handleSave}>
                <SaveIcon className="mr-1 size-3" /> Save
              </Button>
              <Button size="sm" variant="outline" onClick={handleSubmitReview}>
                <SendIcon className="mr-1 size-3" /> Submit for Review
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-purple-600 hover:text-purple-700"
                onClick={() => handleAiRewrite(editContent)}
                disabled={aiLoading}
              >
                <SparklesIcon className="mr-1 size-3" /> Ask AI to Rewrite
              </Button>
              <Button size="sm" variant="ghost" onClick={handleGenerateSeo} disabled={aiLoading}>
                <SearchIcon className="mr-1 size-3" /> Generate SEO Meta
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a content draft to edit.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
