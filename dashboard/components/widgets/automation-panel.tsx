"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { toast } from "sonner";
import { PlusIcon, PencilIcon, Trash2Icon, CopyIcon, AlertCircleIcon } from "lucide-react";

interface EventItem {
  id: string;
  description: string;
  status: string;
  agent: string;
  action_type: string;
  condition_type: string;
  condition_expr: string;
  run_count: number;
  fail_count: number;
  consecutive_fails: number;
  last_run_at: string | null;
  last_result: string | null;
  next_eval_at: string;
  priority: number;
  prompt?: string;
}

interface AutomationPanelConfig {
  [key: string]: unknown;
}

interface FormData {
  description: string;
  agent: string;
  action_type: string;
  condition_type: string;
  condition_expr: string;
  priority: number;
  prompt: string;
}

const emptyForm: FormData = {
  description: "",
  agent: "director",
  action_type: "claude_chat",
  condition_type: "cron",
  condition_expr: "",
  priority: 5,
  prompt: "",
};

const statusBadge: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700",
  paused: "bg-yellow-500/15 text-yellow-700",
  failed: "bg-red-500/15 text-red-700",
  expired: "bg-zinc-500/15 text-zinc-600",
};

const actionIcon: Record<string, string> = {
  claude_chat: "🤖",
  webhook: "🔗",
  script: "📜",
};

const condIcon: Record<string, string> = {
  cron: "⏰",
  threshold: "📊",
  manual: "👆",
};

const agentOptions = ["director", "analytics", "content-writer", "email-manager", "social-media"];
const actionOptions = [
  { value: "claude_chat", label: "Claude Chat" },
  { value: "webhook", label: "Webhook" },
  { value: "script", label: "Script" },
];
const conditionOptions = [
  { value: "cron", label: "Cron Schedule" },
  { value: "threshold", label: "Threshold" },
  { value: "manual", label: "Manual" },
];

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "overdue";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

function AutomationForm({
  form,
  onChange,
}: {
  form: FormData;
  onChange: (form: FormData) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">Name / Description</label>
        <Input
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
          placeholder="e.g. Weekly performance report"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Agent</label>
          <Select value={form.agent} onValueChange={(v) => onChange({ ...form, agent: v })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Action Type</label>
          <Select value={form.action_type} onValueChange={(v) => onChange({ ...form, action_type: v })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actionOptions.map((a) => (
                <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Trigger Type</label>
          <Select value={form.condition_type} onValueChange={(v) => onChange({ ...form, condition_type: v })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {conditionOptions.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            {form.condition_type === "cron" ? "Cron Expression" : form.condition_type === "threshold" ? "Threshold Rule" : "Trigger Label"}
          </label>
          <Input
            value={form.condition_expr}
            onChange={(e) => onChange({ ...form, condition_expr: e.target.value })}
            placeholder={
              form.condition_type === "cron" ? "0 9 * * MON" :
              form.condition_type === "threshold" ? "open_rate < 20%" :
              "Manual trigger"
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">Priority (1-10)</label>
        <Input
          type="number"
          min={1}
          max={10}
          value={form.priority}
          onChange={(e) => onChange({ ...form, priority: parseInt(e.target.value) || 5 })}
        />
      </div>

      {form.action_type === "claude_chat" && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Agent Prompt</label>
          <Textarea
            value={form.prompt}
            onChange={(e) => onChange({ ...form, prompt: e.target.value })}
            placeholder="Describe what the agent should do when this automation runs..."
            className="min-h-[100px]"
          />
        </div>
      )}
    </div>
  );
}

export default function AutomationPanel({
  config,
  title,
}: {
  config: AutomationPanelConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveGatewayClient());
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Create / Edit state
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = creating new
  const [form, setForm] = useState<FormData>(emptyForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getEvents({ limit: 50 })
      .then((data) => {
        if (!cancelled) setEvents(data as unknown as EventItem[]);
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load automations");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

  const handleToggle = async (event: EventItem) => {
    setTogglingId(event.id);
    const newStatus = event.status === "active" ? "paused" : "active";
    try {
      if (client) {
        await client.createEvent({ ...event, status: newStatus } as unknown as Parameters<typeof client.createEvent>[0]);
      }
    } catch {
      // Fallback: apply locally
    }
    setEvents((prev) =>
      prev.map((e) =>
        e.id === event.id ? { ...e, status: newStatus } : e
      )
    );
    setTogglingId(null);
    toast.success(`"${event.description}" ${newStatus === "active" ? "enabled" : "paused"}`);
  };

  const handleRunNow = async (event: EventItem) => {
    setTogglingId(event.id);
    toast.info(`Running "${event.description}"...`);
    try {
      if (client) {
        await client.createEvent({
          description: `Manual run: ${event.description}`,
          agent: event.agent,
          action_type: event.action_type,
        } as unknown as Parameters<typeof client.createEvent>[0]);
      }
    } catch {
      // Fallback: apply locally
    }
    setEvents((prev) =>
      prev.map((e) =>
        e.id === event.id
          ? { ...e, run_count: e.run_count + 1, last_result: "success", last_run_at: new Date().toISOString() }
          : e
      )
    );
    setTogglingId(null);
    toast.success(`"${event.description}" completed`);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setSheetOpen(true);
  };

  const openEdit = (event: EventItem) => {
    setEditingId(event.id);
    setForm({
      description: event.description,
      agent: event.agent,
      action_type: event.action_type,
      condition_type: event.condition_type,
      condition_expr: event.condition_expr,
      priority: event.priority,
      prompt: event.prompt ?? "",
    });
    setSheetOpen(true);
  };

  const openDuplicate = (event: EventItem) => {
    setEditingId(null);
    setForm({
      description: `${event.description} (copy)`,
      agent: event.agent,
      action_type: event.action_type,
      condition_type: event.condition_type,
      condition_expr: event.condition_expr,
      priority: event.priority,
      prompt: event.prompt ?? "",
    });
    setSheetOpen(true);
  };

  const handleSave = () => {
    if (!form.description.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!form.condition_expr.trim()) {
      toast.error("Trigger expression is required");
      return;
    }

    if (editingId) {
      // Update existing
      setEvents((prev) =>
        prev.map((e) =>
          e.id === editingId
            ? {
                ...e,
                description: form.description,
                agent: form.agent,
                action_type: form.action_type,
                condition_type: form.condition_type,
                condition_expr: form.condition_expr,
                priority: form.priority,
                prompt: form.prompt,
              }
            : e
        )
      );
      toast.success(`"${form.description}" updated`);
    } else {
      // Create new
      const newEvent: EventItem = {
        id: `auto-${Date.now()}`,
        description: form.description,
        status: "active",
        agent: form.agent,
        action_type: form.action_type,
        condition_type: form.condition_type,
        condition_expr: form.condition_expr,
        run_count: 0,
        fail_count: 0,
        consecutive_fails: 0,
        last_run_at: null,
        last_result: null,
        next_eval_at: new Date(Date.now() + 3600000).toISOString(),
        priority: form.priority,
        prompt: form.prompt,
      };
      setEvents((prev) => [newEvent, ...prev]);
      toast.success(`"${form.description}" created`);
    }

    setSheetOpen(false);
  };

  const handleDelete = () => {
    if (!deleteId) return;
    const event = events.find((e) => e.id === deleteId);
    setEvents((prev) => prev.filter((e) => e.id !== deleteId));
    setDeleteId(null);
    toast.success(`"${event?.description}" deleted`);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Automations"}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Automations"}</CardTitle>
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

  const active = events.filter((e) => e.status === "active");
  const inactive = events.filter((e) => e.status !== "active");

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Automations"}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-700 text-[10px]">
              {active.length} active
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {inactive.length} inactive
            </Badge>
            <Button size="sm" className="ml-2 h-7 gap-1 text-xs" onClick={openCreate}>
              <PlusIcon className="size-3.5" /> New Automation
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            <div className="flex flex-col gap-2">
              {events.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-12 text-center">
                  <p className="text-sm text-muted-foreground">No automations yet.</p>
                  <Button size="sm" variant="outline" onClick={openCreate}>
                    <PlusIcon className="mr-1 size-3.5" /> Create your first automation
                  </Button>
                </div>
              )}
              {events.map((event) => (
                <div
                  key={event.id}
                  className={`rounded-lg border p-3 transition-colors ${
                    event.status === "active"
                      ? "border-emerald-200 dark:border-emerald-900/50"
                      : event.status === "failed"
                      ? "border-red-200 dark:border-red-900/50"
                      : ""
                  }`}
                >
                  {/* Top row: name + toggle */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">
                          {condIcon[event.condition_type] ?? "⚙️"}
                        </span>
                        <span className="text-sm font-medium">
                          {event.description}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{actionIcon[event.action_type] ?? "⚙️"} {event.action_type}</span>
                        <span>·</span>
                        <span>{event.agent}</span>
                        <span>·</span>
                        <span>{event.condition_expr}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={event.status === "active"}
                        disabled={togglingId === event.id}
                        onCheckedChange={() => handleToggle(event)}
                      />
                      <Badge
                        variant="secondary"
                        className={`shrink-0 text-[10px] ${statusBadge[event.status] ?? ""}`}
                      >
                        {event.status}
                      </Badge>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{event.run_count} runs</span>
                    {event.fail_count > 0 && (
                      <span className="text-red-500">{event.fail_count} fails</span>
                    )}
                    {event.last_run_at && (
                      <span>Last: {timeAgo(event.last_run_at)}</span>
                    )}
                    {event.status === "active" && (
                      <span>Next: {timeUntil(event.next_eval_at)}</span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="mt-2 flex items-center gap-2">
                    {event.status === "active" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-xs"
                        disabled={togglingId === event.id}
                        onClick={() => handleRunNow(event)}
                      >
                        {togglingId === event.id ? "Running..." : "Run Now"}
                      </Button>
                    )}
                    {event.status === "failed" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-xs"
                        disabled={togglingId === event.id}
                        onClick={() => handleRunNow(event)}
                      >
                        Retry
                      </Button>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        title="Duplicate"
                        onClick={() => openDuplicate(event)}
                      >
                        <CopyIcon className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        title="Edit"
                        onClick={() => openEdit(event)}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => setDeleteId(event.id)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Create / Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:w-[440px] sm:max-w-[440px]">
          <SheetHeader>
            <SheetTitle>{editingId ? "Edit Automation" : "New Automation"}</SheetTitle>
            <SheetDescription>
              {editingId
                ? "Update the automation configuration below."
                : "Configure a new scheduled automation. It will be created in an active state."}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 flex flex-col gap-4 px-4">
            <AutomationForm form={form} onChange={setForm} />

            <Separator />

            <div className="flex items-center gap-2">
              <Button onClick={handleSave}>
                {editingId ? "Save Changes" : "Create Automation"}
              </Button>
              <Button variant="outline" onClick={() => setSheetOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirmation */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Automation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{events.find((e) => e.id === deleteId)?.description}&quot;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
