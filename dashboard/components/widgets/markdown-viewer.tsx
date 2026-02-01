"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { renderMarkdown } from "@/lib/sanitize";

interface MarkdownViewerConfig {
  path?: string;
  content?: string;
  [key: string]: unknown;
}

export default function MarkdownViewer({
  config,
  title,
}: {
  config: MarkdownViewerConfig;
  title?: string;
}) {
  const content = config.content as string | undefined;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {title ?? "Document"}
          {config.path && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">{config.path}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[350px] px-6 pb-6">
          {content ? (
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          ) : (
            <div className="flex flex-col gap-3 pt-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-6 w-40 pt-2" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
