"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { useAgentStream } from "@/lib/hooks/use-agent-stream";
import { toast } from "sonner";
import { SparklesIcon, GlobeIcon, CalendarIcon, CheckCircleIcon, AlertCircleIcon } from "lucide-react";
import dynamic from "next/dynamic";

const RichEditor = dynamic(
  () => import("@/components/ui/rich-editor").then((m) => ({ default: m.RichEditor })),
  { ssr: false, loading: () => <Skeleton className="h-[200px] w-full" /> }
);

interface SocialPost {
  title: string;
  client: string;
  platform: string;
  status: string;
  scheduled_date: string;
  engagement: string;
  caption?: string;
}

interface RegistryData {
  name: string;
  data: {
    fields: { name: string; type: string }[];
    entries: SocialPost[];
  };
}

interface SocialPostsGridConfig {
  registry?: string;
  [key: string]: unknown;
}

const statusBadge: Record<string, string> = {
  published: "bg-emerald-500/15 text-emerald-700",
  scheduled: "bg-blue-500/15 text-blue-700",
  draft: "bg-zinc-500/15 text-zinc-600",
  "pending approval": "bg-yellow-500/15 text-yellow-700",
};

const platformIcon: Record<string, string> = {
  Instagram: "📸",
  LinkedIn: "💼",
  "X / Twitter": "𝕏",
  Facebook: "📘",
  Pinterest: "📌",
};

/** Generate a deterministic placeholder image URL from the post title */
function postImageUrl(title: string, width = 400, height = 240): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash << 5) - hash + title.charCodeAt(i);
    hash |= 0;
  }
  const seed = Math.abs(hash) % 1000;
  return `https://picsum.photos/seed/${seed}/${width}/${height}`;
}

export default function SocialPostsGrid({
  config,
  title,
}: {
  config: SocialPostsGridConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [selectedPost, setSelectedPost] = useState<SocialPost | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editCaption, setEditCaption] = useState("");

  const regen = useAgentStream();
  const translate = useAgentStream();
  const aiLoading = regen.status === "streaming" || regen.status === "connecting" ||
                    translate.status === "streaming" || translate.status === "connecting";

  const registryName = config.registry ?? "social-posts";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getRegistry(registryName)
      .then((data) => {
        if (!cancelled) {
          const rd = data as unknown as RegistryData;
          setPosts(rd?.data?.entries ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load social posts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, registryName]);

  const filtered = filter === "all" ? posts : posts.filter((p) => p.status === filter);
  const statuses = ["all", "published", "scheduled", "draft"];

  const openDetail = (post: SocialPost) => {
    setSelectedPost(post);
    setEditCaption(post.caption ?? post.title);
    setSheetOpen(true);
  };

  const handleRegenerate = () => {
    toast.info("Regenerating caption...", { description: "Sending to social-media agent" });
    regen.fire("social-media", `Regenerate and improve this social media caption for ${selectedPost?.platform}: "${editCaption}"`);
  };

  // Apply regen result to caption
  useEffect(() => {
    if (regen.status === "done" && regen.response) {
      setEditCaption((prev) => `${prev}\n\n${regen.response}`);
      toast.success("Caption regenerated");
    }
  }, [regen.status, regen.response]);

  const handleTranslate = () => {
    toast.info("Translating...", { description: "social-media agent: Translating to Spanish" });
    translate.fire("social-media", `Translate this caption to Spanish: "${editCaption}"`);
  };

  useEffect(() => {
    if (translate.status === "done") {
      toast.success("Translation complete");
    }
  }, [translate.status]);

  const handleSchedule = () => {
    if (selectedPost) {
      setPosts((prev) => prev.map((p) => p === selectedPost ? { ...p, status: "scheduled" } : p));
      setSelectedPost({ ...selectedPost, status: "scheduled" });
      toast.success(`"${selectedPost.title}" scheduled`, { description: "social-media agent: Post scheduled" });
    }
  };

  const handleApprove = () => {
    if (selectedPost) {
      setPosts((prev) => prev.map((p) => p === selectedPost ? { ...p, status: "published" } : p));
      setSelectedPost({ ...selectedPost, status: "published" });
      toast.success(`"${selectedPost.title}" approved`, { description: "social-media agent: Publishing post" });
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Social Posts"}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Skeleton key={n} className="h-40 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Social Posts"}</CardTitle>
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
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Social Posts"}</CardTitle>
          <div className="flex gap-1">
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                  filter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[420px]">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {filtered.map((post, i) => (
                <div
                  key={i}
                  onClick={() => openDetail(post)}
                  className="flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-shadow hover:shadow-md"
                >
                  <div className="relative h-24 overflow-hidden">
                    <img
                      src={postImageUrl(post.title)}
                      alt={post.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    <div className="absolute bottom-1.5 left-1.5 rounded-full bg-white/90 px-1.5 py-0.5 text-xs shadow backdrop-blur-sm">
                      {platformIcon[post.platform] ?? "📱"} {post.platform}
                    </div>
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-3">
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-sm font-medium leading-tight">{post.title}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {post.client} · {post.platform}
                    </span>
                    <div className="mt-auto flex items-center justify-between pt-1">
                      <span className="text-xs text-muted-foreground">{post.scheduled_date}</span>
                      <Badge variant="secondary" className={`text-[10px] ${statusBadge[post.status] ?? ""}`}>
                        {post.status}
                      </Badge>
                    </div>
                    {post.engagement && post.engagement !== "—" && (
                      <span className="text-xs font-medium text-emerald-600">{post.engagement}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {filtered.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No posts match this filter.</p>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:w-[420px] sm:max-w-[420px]">
          {selectedPost && (
            <>
              <SheetHeader>
                <SheetTitle className="text-base">{selectedPost.title}</SheetTitle>
                <SheetDescription>
                  {selectedPost.client} · {selectedPost.platform} · {selectedPost.scheduled_date}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-col gap-4 px-4">
                <div className="overflow-hidden rounded-lg">
                  <img
                    src={postImageUrl(selectedPost.title, 600, 360)}
                    alt={selectedPost.title}
                    className="h-48 w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className={`text-xs ${statusBadge[selectedPost.status] ?? ""}`}>
                    {selectedPost.status}
                  </Badge>
                  {selectedPost.engagement && selectedPost.engagement !== "—" && (
                    <span className="text-xs font-medium text-emerald-600">{selectedPost.engagement}</span>
                  )}
                </div>

                <Separator />

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Caption / Content</span>
                  <RichEditor
                    content={editCaption}
                    onChange={setEditCaption}
                    placeholder="Post caption..."
                    onAiImprove={async () => handleRegenerate()}
                    aiLoading={aiLoading}
                  />
                </div>

                <Separator />

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">AI Actions</span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={handleRegenerate} disabled={aiLoading}>
                      <SparklesIcon className="mr-1 size-3" /> Regenerate Caption
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleTranslate} disabled={aiLoading}>
                      <GlobeIcon className="mr-1 size-3" /> Translate
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleSchedule}>
                      <CalendarIcon className="mr-1 size-3" /> Schedule
                    </Button>
                    <Button size="sm" variant="default" onClick={handleApprove}>
                      <CheckCircleIcon className="mr-1 size-3" /> Approve
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
