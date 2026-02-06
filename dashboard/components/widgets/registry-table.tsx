"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { toast } from "sonner";
import { SparklesIcon, FileTextIcon, PencilIcon, Trash2Icon, MoreHorizontalIcon, AlertCircleIcon } from "lucide-react";

interface ColumnConfig {
  field: string;
  label: string;
}

interface RegistryTableConfig {
  registry?: string;
  columns?: (string | ColumnConfig)[];
  searchable?: boolean;
  [key: string]: unknown;
}

function normalizeColumn(col: string | ColumnConfig): ColumnConfig {
  if (typeof col === "string") {
    return { field: col, label: col.replace(/_/g, " ") };
  }
  return col;
}

interface RegistryData {
  name: string;
  data: {
    fields: { name: string; type: string }[];
    entries: Record<string, string>[];
  };
}

export default function RegistryTable({
  config,
  title,
}: {
  config: RegistryTableConfig;
  title?: string;
}) {
  const searchable = config.searchable !== false;
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !config.registry) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    client
      .getRegistry(config.registry)
      .then((data) => {
        if (!cancelled) setRegistry(data as unknown as RegistryData);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load registry");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, config.registry]);

  const fields = registry?.data?.fields ?? [];
  const rawColumns = config.columns ?? fields.map((f) => f.name);
  const columns = rawColumns.map(normalizeColumn);
  const entries = registry?.data?.entries ?? [];

  const filtered = search
    ? entries.filter((e) =>
        Object.values(e).some((v) =>
          String(v).toLowerCase().includes(search.toLowerCase())
        )
      )
    : entries;

  const handleAskAi = (entry: Record<string, string>) => {
    const summary = Object.entries(entry).map(([k, v]) => `${k}: ${v}`).join(", ");
    toast.info("Ask AI about this row", {
      description: `Opening chat pre-filled with: "${summary.slice(0, 100)}..."`,
    });
  };

  const handleGenerateReport = (entry: Record<string, string>) => {
    const name = entry.name || entry.title || Object.values(entry)[0] || "entry";
    toast.info(`Generating report for "${name}"...`, {
      description: "Analytics agent: Compiling report data...",
    });
  };

  const handleEditRow = (idx: number) => {
    setEditingRow(idx);
    setEditValues({ ...filtered[idx] });
  };

  const handleSaveEdit = () => {
    if (editingRow === null || !registry) return;
    const updated = [...entries];
    const realIdx = entries.indexOf(filtered[editingRow]);
    if (realIdx >= 0) updated[realIdx] = { ...editValues };
    setRegistry({ ...registry, data: { ...registry.data, entries: updated } });
    setEditingRow(null);
    toast.success("Row updated");
  };

  const handleDelete = () => {
    if (deleteIdx === null || !registry) return;
    const toDelete = filtered[deleteIdx];
    const updated = entries.filter((e) => e !== toDelete);
    setRegistry({ ...registry, data: { ...registry.data, entries: updated } });
    setDeleteIdx(null);
    toast.success("Row deleted");
  };

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Registry"}</CardTitle>
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
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Registry"}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {searchable && (
            <Input
              placeholder="Search registry..."
              className="h-8 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
          <ScrollArea className="h-[280px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  {columns.map((col) => (
                    <th key={col.field} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground capitalize">
                      {col.label}
                    </th>
                  ))}
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {loading
                  ? [1, 2, 3].map((n) => (
                      <tr key={n} className="border-b last:border-0">
                        {columns.map((col) => (
                          <td key={col.field} className="px-3 py-2">
                            <Skeleton className="h-4 w-20" />
                          </td>
                        ))}
                        <td className="px-2 py-2" />
                      </tr>
                    ))
                  : filtered.map((entry, i) => (
                      <ContextMenu key={i}>
                        <ContextMenuTrigger asChild>
                          <tr className="border-b last:border-0 hover:bg-muted/50 cursor-context-menu">
                            {columns.map((col) => (
                              <td key={col.field} className="px-3 py-2">
                                {editingRow === i ? (
                                  <Input
                                    className="h-7 text-xs"
                                    value={editValues[col.field] ?? ""}
                                    onChange={(e) => setEditValues((v) => ({ ...v, [col.field]: e.target.value }))}
                                  />
                                ) : (
                                  String(entry[col.field] ?? "—")
                                )}
                              </td>
                            ))}
                            {/* Keyboard-accessible actions menu */}
                            <td className="px-2 py-2">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                                    <MoreHorizontalIcon className="size-4" />
                                    <span className="sr-only">Row actions</span>
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                  <DropdownMenuItem onClick={() => handleAskAi(entry)}>
                                    <SparklesIcon className="mr-2 size-4" /> Ask AI about this...
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleGenerateReport(entry)}>
                                    <FileTextIcon className="mr-2 size-4" /> Generate report for...
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  {editingRow === i ? (
                                    <DropdownMenuItem onClick={handleSaveEdit}>
                                      <PencilIcon className="mr-2 size-4" /> Save Changes
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem onClick={() => handleEditRow(i)}>
                                      <PencilIcon className="mr-2 size-4" /> Edit
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem className="text-destructive" onClick={() => setDeleteIdx(i)}>
                                    <Trash2Icon className="mr-2 size-4" /> Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </td>
                          </tr>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuLabel>Actions</ContextMenuLabel>
                          <ContextMenuItem onClick={() => handleAskAi(entry)}>
                            <SparklesIcon className="mr-2 size-4" /> Ask AI about this...
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => handleGenerateReport(entry)}>
                            <FileTextIcon className="mr-2 size-4" /> Generate report for...
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          {editingRow === i ? (
                            <ContextMenuItem onClick={handleSaveEdit}>
                              <PencilIcon className="mr-2 size-4" /> Save Changes
                            </ContextMenuItem>
                          ) : (
                            <ContextMenuItem onClick={() => handleEditRow(i)}>
                              <PencilIcon className="mr-2 size-4" /> Edit
                            </ContextMenuItem>
                          )}
                          <ContextMenuItem variant="destructive" onClick={() => setDeleteIdx(i)}>
                            <Trash2Icon className="mr-2 size-4" /> Delete
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ))}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={(columns.length || 0) + 1} className="px-3 py-6 text-center text-muted-foreground">
                      No entries found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </ScrollArea>
          {editingRow !== null && (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSaveEdit}>Save</Button>
              <Button size="sm" variant="outline" onClick={() => setEditingRow(null)}>Cancel</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteIdx !== null} onOpenChange={(open) => { if (!open) setDeleteIdx(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Entry</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this entry? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteIdx(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
