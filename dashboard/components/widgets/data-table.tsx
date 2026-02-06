"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ColumnConfig {
  field: string;
  label: string;
}

interface DataTableConfig {
  source?: string;
  columns?: (string | ColumnConfig)[];
  [key: string]: unknown;
}

const defaultColumns: ColumnConfig[] = [
  { field: "id", label: "ID" },
  { field: "name", label: "Name" },
  { field: "value", label: "Value" },
  { field: "updated", label: "Updated" },
];

function normalizeColumn(col: string | ColumnConfig): ColumnConfig {
  if (typeof col === "string") {
    return { field: col, label: col.replace(/_/g, " ") };
  }
  return col;
}

export default function DataTable({
  config,
  title,
}: {
  config: DataTableConfig;
  title?: string;
}) {
  const columns = (config.columns ?? defaultColumns).map(normalizeColumn);

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
                  <th key={col.field} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground capitalize">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((n) => (
                <tr key={n} className="border-b last:border-0">
                  {columns.map((col) => (
                    <td key={col.field} className="px-4 py-2">
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
