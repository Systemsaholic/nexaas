"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

interface DataTableConfig {
  source?: string;
  columns?: string[];
  [key: string]: unknown;
}

const defaultColumns = ["ID", "Name", "Value", "Updated"];

export default function DataTable({
  config,
  title,
}: {
  config: DataTableConfig;
  title?: string;
}) {
  const columns = config.columns ?? defaultColumns;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {title ?? "Data Table"}
          {config.source && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {config.source}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b">
                {columns.map((col) => (
                  <th key={col} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((n) => (
                <tr key={n} className="border-b last:border-0">
                  {columns.map((col) => (
                    <td key={col} className="px-4 py-2">
                      <Skeleton className="h-4 w-24" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
