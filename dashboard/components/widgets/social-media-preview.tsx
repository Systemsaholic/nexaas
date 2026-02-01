"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";

interface SocialMediaPreviewConfig {
  platform?: string;
  source?: string;
  [key: string]: unknown;
}

export default function SocialMediaPreview({
  config,
  title,
}: {
  config: SocialMediaPreviewConfig;
  title?: string;
}) {
  const platform = config.platform ?? "twitter";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{title ?? "Social Post"}</CardTitle>
          <Badge variant="outline" className="text-[10px] capitalize">
            {platform}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="text-xs">AI</AvatarFallback>
          </Avatar>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex flex-col gap-1.5 pt-1">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6 border-t pt-3 text-xs text-muted-foreground">
          <span>0 likes</span>
          <span>0 replies</span>
          <span>0 reposts</span>
          <span>0 views</span>
        </div>
      </CardContent>
    </Card>
  );
}
