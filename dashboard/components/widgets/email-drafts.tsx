"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useAgentStream } from "@/lib/hooks/use-agent-stream";
import { toast } from "sonner";
import { PencilIcon, SparklesIcon, SendIcon, XIcon, AlertCircleIcon } from "lucide-react";
import dynamic from "next/dynamic";

const RichEditor = dynamic(
  () => import("@/components/ui/rich-editor").then((m) => ({ default: m.RichEditor })),
  { ssr: false, loading: () => <Skeleton className="h-[300px] w-full" /> }
);

interface EmailDraft {
  subject: string;
  to: string;
  client: string;
  campaign: string;
  status: string;
  created: string;
  body: string;
}

interface RegistryData {
  name: string;
  data: {
    fields: { name: string; type: string }[];
    entries: EmailDraft[];
  };
}

interface EmailDraftsConfig {
  registry?: string;
  [key: string]: unknown;
}

const statusBadge: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-600",
  "pending approval": "bg-yellow-500/15 text-yellow-700",
  approved: "bg-emerald-500/15 text-emerald-700",
  "revision requested": "bg-orange-500/15 text-orange-700",
};

export default function EmailDrafts({
  config,
  title,
}: {
  config: EmailDraftsConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveGatewayClient());
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");

  const rewrite = useAgentStream();
  const aiLoading = rewrite.status === "streaming" || rewrite.status === "connecting";

  const registryName = config.registry ?? "email-drafts";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getRegistry(registryName)
      .then((data) => {
        if (!cancelled) {
          const rd = data as unknown as RegistryData;
          setDrafts(rd?.data?.entries ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load email drafts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, registryName]);

  const draft = drafts[selected];

  const handleEdit = () => {
    if (draft) {
      setEditBody(draft.body);
      setEditing(true);
    }
  };

  const handleSave = () => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === selected ? { ...d, body: editBody } : d))
    );
    setEditing(false);
    toast.success("Draft saved");
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditBody("");
  };

  const handleAiRewrite = useCallback((content: string) => {
    toast.info("Asking AI to rewrite...", { description: "Sending to email-manager agent" });
    rewrite.fire("email-manager", `Rewrite and improve this email for clarity, tone, and call-to-action: "${content.replace(/<[^>]*>/g, "").slice(0, 500)}"`);
  }, [draft, rewrite]);

  useEffect(() => {
    if (rewrite.status === "done" && rewrite.response) {
      const improved = `<p>${rewrite.response.replace(/\n/g, "</p><p>")}</p>`;
      setEditBody(improved);
      toast.success("AI rewrite complete", { description: "Email-manager agent finished revision" });
    }
  }, [rewrite.status, rewrite.response]);

  const handleApprove = () => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === selected ? { ...d, status: "approved" } : d))
    );
    toast.success(`"${draft?.subject}" approved & sent`, {
      description: "Email-manager agent: Sending email...",
    });
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Email Drafts"}</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-4">
          <div className="flex w-[280px] shrink-0 flex-col gap-2">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-16 w-full" />
            ))}
          </div>
          <div className="flex-1">
            <Skeleton className="h-[400px] w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Email Drafts"}</CardTitle>
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
        <CardTitle className="text-sm font-medium">{title ?? "Email Drafts"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row">
        {/* Left: email list */}
        <ScrollArea className="h-[480px] w-full shrink-0 rounded-md border sm:w-[300px]">
          <div className="flex flex-col">
            {drafts.map((d, i) => (
              <button
                key={i}
                onClick={() => { setSelected(i); setEditing(false); }}
                className={`flex flex-col gap-1 border-b px-3 py-3 text-left transition-colors last:border-0 ${
                  i === selected ? "bg-primary/[0.06]" : "hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{d.subject}</span>
                  {i === selected && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                </div>
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs text-muted-foreground">{d.client}</span>
                  <Badge variant="secondary" className={`ml-auto shrink-0 text-[10px] ${statusBadge[d.status] ?? "bg-zinc-500/15 text-zinc-600"}`}>
                    {d.status}
                  </Badge>
                </div>
              </button>
            ))}
            {drafts.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">No email drafts.</p>
            )}
          </div>
        </ScrollArea>

        {/* Right: email preview / editor */}
        {draft ? (
          <div className="flex flex-1 flex-col gap-3 overflow-hidden">
            {/* Header fields */}
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Subject</span>
                <span className="font-medium">{draft.subject}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">To</span>
                <span className="text-muted-foreground">{draft.to}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Campaign</span>
                <span className="text-muted-foreground">{draft.campaign}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Status</span>
                <Badge variant="secondary" className={`text-[10px] ${statusBadge[draft.status] ?? ""}`}>
                  {draft.status}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Created</span>
                <span className="text-muted-foreground">{draft.created}</span>
              </div>
            </div>

            <Separator />

            {/* Body: view or edit mode */}
            {editing ? (
              <div className="flex flex-1 flex-col gap-2">
                <RichEditor
                  content={editBody}
                  onChange={setEditBody}
                  placeholder="Write your email..."
                  onAiImprove={handleAiRewrite}
                  aiLoading={aiLoading}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleSave}>Save Draft</Button>
                  <Button size="sm" variant="outline" onClick={handleCancelEdit}>
                    <XIcon className="mr-1 size-3" /> Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <ScrollArea className="flex-1 rounded-md border bg-muted/30">
                <div className="whitespace-pre-wrap p-4 text-sm leading-relaxed">{draft.body}</div>
              </ScrollArea>
            )}

            {/* Action buttons */}
            {!editing && (draft.status === "pending approval" || draft.status === "draft") && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="default" onClick={handleApprove}>
                  <SendIcon className="mr-1 size-3" /> Approve & Send
                </Button>
                <Button size="sm" variant="outline" onClick={handleEdit}>
                  <PencilIcon className="mr-1 size-3" /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-purple-600 hover:text-purple-700"
                  onClick={() => {
                    handleEdit();
                    setTimeout(() => handleAiRewrite(draft.body), 100);
                  }}
                  disabled={aiLoading}
                >
                  <SparklesIcon className="mr-1 size-3" /> Ask AI to Rewrite
                </Button>
              </div>
            )}
            {!editing && draft.status === "revision requested" && (
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="default" onClick={handleApprove}>Approve Revision</Button>
                <Button size="sm" variant="outline" onClick={handleEdit}>
                  <PencilIcon className="mr-1 size-3" /> Edit
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select an email to preview.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
