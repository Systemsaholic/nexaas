"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface ChartConfig {
  query?: string;
  chart_type?: string;
  [key: string]: unknown;
}

export default function Chart({
  config,
  title,
}: {
  config: ChartConfig;
  title?: string;
}) {
  const chartType = config.chart_type ?? "bar";

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{title ?? "Chart"}</CardTitle>
          <Badge variant="outline" className="text-[10px] capitalize">{chartType}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex h-[260px] flex-col items-center justify-center rounded-md border border-dashed bg-muted/30">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
              <rect x="3" y="12" width="4" height="9" rx="1" />
              <rect x="10" y="6" width="4" height="15" rx="1" />
              <rect x="17" y="3" width="4" height="18" rx="1" />
            </svg>
            <span className="text-sm">Chart placeholder</span>
            {config.query && (
              <span className="max-w-[200px] truncate text-xs">{config.query}</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
