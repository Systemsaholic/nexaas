"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

interface PipelineBoardConfig {
  stages?: string[];
  source?: string;
  [key: string]: unknown;
}

const defaultStages = ["Backlog", "In Progress", "Review", "Done"];

const placeholderCards: Record<string, Array<{ title: string; tag?: string }>> = {
  Backlog: [{ title: "Research competitor pricing", tag: "research" }, { title: "Draft blog post", tag: "content" }],
  "In Progress": [{ title: "Update landing page copy", tag: "content" }],
  Review: [{ title: "Social campaign v2", tag: "marketing" }],
  Done: [{ title: "Email sequence A/B test", tag: "email" }],
};

export default function PipelineBoard({
  config,
  title,
}: {
  config: PipelineBoardConfig;
  title?: string;
}) {
  const stages = config.stages ?? defaultStages;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Pipeline"}</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="flex gap-3" style={{ minWidth: stages.length * 220 }}>
            {stages.map((stage) => {
              const cards = placeholderCards[stage] ?? [];
              return (
                <div key={stage} className="flex w-[200px] shrink-0 flex-col gap-2">
                  <div className="flex items-center justify-between rounded-md bg-muted px-3 py-1.5">
                    <span className="text-xs font-medium">{stage}</span>
                    <Badge variant="secondary" className="text-[10px]">{cards.length}</Badge>
                  </div>
                  <div className="flex min-h-[180px] flex-col gap-2">
                    {cards.map((card, i) => (
                      <div key={i} className="rounded-md border bg-card p-3 shadow-sm">
                        <p className="text-sm">{card.title}</p>
                        {card.tag && (
                          <Badge variant="outline" className="mt-1.5 text-[10px]">{card.tag}</Badge>
                        )}
                      </div>
                    ))}
                    {cards.length === 0 && (
                      <Skeleton className="h-16 w-full rounded-md" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
