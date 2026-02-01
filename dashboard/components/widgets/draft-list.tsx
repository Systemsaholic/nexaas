"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface Draft {
  title: string;
  type: string;
  status: "pending" | "approved" | "rejected";
  updated: string;
}

interface DraftListConfig {
  show_approval_buttons?: boolean;
  [key: string]: unknown;
}

const placeholderDrafts: Draft[] = [
  { title: "Weekly newsletter #42", type: "email", status: "pending", updated: "5 min ago" },
  { title: "Product launch announcement", type: "post", status: "pending", updated: "1 hr ago" },
  { title: "Partner outreach template", type: "email", status: "approved", updated: "3 hr ago" },
  { title: "Blog: AI trends 2026", type: "article", status: "rejected", updated: "Yesterday" },
];

const statusBadge: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-700",
  approved: "bg-emerald-500/15 text-emerald-700",
  rejected: "bg-red-500/15 text-red-700",
};

export default function DraftList({
  config,
  title,
}: {
  config: DraftListConfig;
  title?: string;
}) {
  const showButtons = config.show_approval_buttons !== false;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Drafts"}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[320px]">
          {placeholderDrafts.map((draft, i) => (
            <div key={i}>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{draft.title}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{draft.type}</Badge>
                    <span className="text-xs text-muted-foreground">{draft.updated}</span>
                  </div>
                </div>
                <Badge variant="secondary" className={`text-[10px] ${statusBadge[draft.status]}`}>
                  {draft.status}
                </Badge>
                {showButtons && draft.status === "pending" && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="h-7 text-xs">
                      Reject
                    </Button>
                    <Button size="sm" className="h-7 text-xs">
                      Approve
                    </Button>
                  </div>
                )}
              </div>
              {i < placeholderDrafts.length - 1 && <Separator />}
            </div>
          ))}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
