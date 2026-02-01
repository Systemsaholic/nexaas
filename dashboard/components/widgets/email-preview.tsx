"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

interface EmailPreviewConfig {
  source?: string;
  [key: string]: unknown;
}

export default function EmailPreview({
  config,
  title,
}: {
  config: EmailPreviewConfig;
  title?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Email Preview"}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5 text-sm">
          {["From", "To", "Subject", "Date"].map((field) => (
            <div key={field} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">{field}</span>
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
        <Separator />
        <div className="min-h-[200px] rounded-md border bg-muted/30 p-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
