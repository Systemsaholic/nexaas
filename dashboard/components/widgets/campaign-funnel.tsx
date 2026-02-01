"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircleIcon } from "lucide-react";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Campaign {
  name: string;
  client: string;
  channel: string;
  status: string;
  budget: string;
  start_date: string;
}

interface RegistryData {
  name: string;
  data: {
    fields: { name: string; type: string }[];
    entries: Campaign[];
  };
}

interface CampaignFunnelConfig {
  registry?: string;
  [key: string]: unknown;
}

const stageOrder = ["draft", "review", "scheduled", "running", "completed"];
const stageLabels: Record<string, string> = {
  draft: "Draft",
  review: "In Review",
  scheduled: "Scheduled",
  running: "Running",
  completed: "Completed",
};
const stageColors: Record<string, string> = {
  draft: "border-l-zinc-400 bg-zinc-50 dark:bg-zinc-900/40",
  review: "border-l-orange-400 bg-orange-50 dark:bg-orange-900/20",
  scheduled: "border-l-blue-400 bg-blue-50 dark:bg-blue-900/20",
  running: "border-l-emerald-400 bg-emerald-50 dark:bg-emerald-900/20",
  completed: "border-l-purple-400 bg-purple-50 dark:bg-purple-900/20",
};
const badgeColors: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-600",
  review: "bg-orange-500/15 text-orange-700",
  scheduled: "bg-blue-500/15 text-blue-700",
  running: "bg-emerald-500/15 text-emerald-700",
  completed: "bg-purple-500/15 text-purple-700",
};
const stageBarColors: Record<string, string> = {
  draft: "#a1a1aa",
  review: "#fb923c",
  scheduled: "#60a5fa",
  running: "#34d399",
  completed: "#a78bfa",
};

function CampaignCard({ campaign, id }: { campaign: Campaign; id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: "campaign", campaign },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`cursor-grab rounded-md border-l-4 p-3 active:cursor-grabbing ${stageColors[campaign.status] ?? ""}`}
    >
      <div className="text-sm font-medium">{campaign.name}</div>
      <div className="text-xs text-muted-foreground">{campaign.client}</div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{campaign.channel}</span>
        <span className="text-xs font-medium">{campaign.budget}</span>
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  campaigns,
  isOver,
}: {
  stage: string;
  campaigns: Campaign[];
  isOver: boolean;
}) {
  const ids = campaigns.map((c, i) => `${stage}-${i}`);

  return (
    <div className={`min-w-[200px] flex-1 rounded-lg p-2 transition-colors ${isOver ? "bg-primary/5 ring-2 ring-primary/20" : ""}`}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium">{stageLabels[stage] ?? stage}</span>
        <Badge variant="secondary" className={`text-[10px] ${badgeColors[stage] ?? ""}`}>
          {campaigns.length}
        </Badge>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[60px] flex-col gap-2">
          {campaigns.map((c, i) => (
            <CampaignCard key={`${stage}-${i}`} campaign={c} id={`${stage}-${i}`} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

export default function CampaignFunnel({
  config,
  title,
}: {
  config: CampaignFunnelConfig;
  title?: string;
}) {
  const client = useWorkspaceStore((s) => s.getActiveEngineClient());
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<Campaign | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);

  const registryName = config.registry ?? "campaigns";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client
      .getRegistry(registryName)
      .then((data) => {
        if (!cancelled) {
          const rd = data as unknown as RegistryData;
          setCampaigns(rd?.data?.entries ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load campaigns");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, registryName]);

  const stageMap = useCallback(() => {
    const map: Record<string, Campaign[]> = {};
    for (const stage of stageOrder) {
      map[stage] = campaigns.filter((c) => c.status === stage);
    }
    return map;
  }, [campaigns]);

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current;
    if (data?.campaign) setActiveItem(data.campaign as Campaign);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverStage(null); return; }
    const overId = String(over.id);
    const stage = overId.split("-")[0];
    if (stageOrder.includes(stage)) setOverStage(stage);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveItem(null);
    setOverStage(null);

    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const fromStage = activeId.split("-")[0];
    const toStage = overId.split("-")[0];

    if (fromStage === toStage) return;

    const activeIdx = parseInt(activeId.split("-")[1]);
    const map = stageMap();
    const campaign = map[fromStage]?.[activeIdx];
    if (!campaign) return;

    setCampaigns((prev) =>
      prev.map((c) =>
        c === campaign ? { ...c, status: toStage } : c
      )
    );

    toast.success(`Moved "${campaign.name}" to ${stageLabels[toStage]}`, {
      description: `Agent command: Move campaign "${campaign.name}" to stage "${toStage}", update status`,
    });
  };

  const stages = stageMap();

  if (fetchError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Campaign Pipeline"}</CardTitle>
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

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title ?? "Campaign Funnel"}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            {[1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-48 flex-1 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Campaign Pipeline"}</CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="pb-2">
          {/* Funnel visualization */}
          <div className="mb-4 flex items-end gap-1">
            {stageOrder.map((stage) => {
              const count = campaigns.filter((c) => c.status === stage).length;
              const maxHeight = 60;
              const height = count > 0 ? Math.max(20, (count / campaigns.length) * maxHeight * 2) : 4;
              return (
                <div key={stage} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-xs font-bold">{count}</span>
                  <div
                    className="w-full rounded-t-sm transition-all"
                    style={{ height: `${height}px`, backgroundColor: stageBarColors[stage], opacity: 0.7 }}
                  />
                  <span className="text-[10px] text-muted-foreground capitalize">{stage}</span>
                </div>
              );
            })}
          </div>

          {/* DnD Kanban columns */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <div className="flex gap-3 overflow-x-auto">
              {stageOrder.map((stage) => (
                <StageColumn
                  key={stage}
                  stage={stage}
                  campaigns={stages[stage] ?? []}
                  isOver={overStage === stage}
                />
              ))}
            </div>
            <DragOverlay>
              {activeItem ? (
                <div className={`w-[200px] rounded-md border-l-4 p-3 shadow-lg ${stageColors[activeItem.status] ?? ""}`}>
                  <div className="text-sm font-medium">{activeItem.name}</div>
                  <div className="text-xs text-muted-foreground">{activeItem.client}</div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
