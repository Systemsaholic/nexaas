"use client";

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

interface SalesPipelineConfig {
  [key: string]: unknown;
}

interface Deal {
  name: string;
  client: string;
  value: string;
  probability: string;
  owner: string;
}

interface Stage {
  name: string;
  color: string;
  bgColor: string;
  deals: Deal[];
  totalValue: string;
}

const initialStages: Stage[] = [
  {
    name: "Lead",
    color: "bg-zinc-400",
    bgColor: "bg-zinc-50 dark:bg-zinc-900/40 border-l-zinc-400",
    totalValue: "$26,700",
    deals: [
      { name: "Social Media Package", client: "TechStart Inc.", value: "$4,200", probability: "20%", owner: "director" },
      { name: "Full-Service Retainer", client: "Horizon Foods", value: "$15,000", probability: "15%", owner: "director" },
      { name: "SEO Audit", client: "CloudNine SaaS", value: "$7,500", probability: "25%", owner: "analytics" },
    ],
  },
  {
    name: "Qualified",
    color: "bg-blue-400",
    bgColor: "bg-blue-50 dark:bg-blue-900/20 border-l-blue-400",
    totalValue: "$24,500",
    deals: [
      { name: "Content Marketing Retainer", client: "PulsePoint Health", value: "$18,500", probability: "50%", owner: "director" },
      { name: "Email Automation Setup", client: "Bloom Wellness", value: "$6,000", probability: "60%", owner: "email-manager" },
    ],
  },
  {
    name: "Proposal",
    color: "bg-orange-400",
    bgColor: "bg-orange-50 dark:bg-orange-900/20 border-l-orange-400",
    totalValue: "$31,000",
    deals: [
      { name: "Q3 Campaign Bundle", client: "VeloCity Bikes", value: "$22,000", probability: "75%", owner: "director" },
      { name: "Product Launch Package", client: "NovaPay", value: "$9,000", probability: "70%", owner: "director" },
    ],
  },
  {
    name: "Negotiation",
    color: "bg-purple-400",
    bgColor: "bg-purple-50 dark:bg-purple-900/20 border-l-purple-400",
    totalValue: "$8,500",
    deals: [
      { name: "Brand Refresh + Social", client: "Greenleaf Organics", value: "$8,500", probability: "85%", owner: "director" },
    ],
  },
  {
    name: "Closed Won",
    color: "bg-emerald-400",
    bgColor: "bg-emerald-50 dark:bg-emerald-900/20 border-l-emerald-400",
    totalValue: "$58,200",
    deals: [
      { name: "Growth Plan", client: "Greenleaf Organics", value: "$8,500", probability: "100%", owner: "director" },
      { name: "Enterprise Plan", client: "VeloCity Bikes", value: "$22,000", probability: "100%", owner: "director" },
      { name: "Starter Plan", client: "NovaPay", value: "$3,200", probability: "100%", owner: "email-manager" },
      { name: "Growth Plan", client: "Birch & Stone Interiors", value: "$6,000", probability: "100%", owner: "content-writer" },
      { name: "Enterprise Plan", client: "PulsePoint Health", value: "$18,500", probability: "100%", owner: "director" },
    ],
  },
];

function DealCard({ deal, id, bgColor }: { deal: Deal; id: string; bgColor: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: "deal", deal },
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
      className={`cursor-grab rounded-md border-l-4 p-2.5 active:cursor-grabbing ${bgColor}`}
    >
      <div className="text-xs font-medium">{deal.name}</div>
      <div className="text-[11px] text-muted-foreground">{deal.client}</div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-xs font-bold">{deal.value}</span>
        <Badge variant="secondary" className="text-[9px]">{deal.probability}</Badge>
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  stageIndex,
  isOver,
}: {
  stage: Stage;
  stageIndex: number;
  isOver: boolean;
}) {
  const ids = stage.deals.map((_, i) => `${stageIndex}-${i}`);

  return (
    <div className={`min-w-[180px] flex-1 rounded-lg p-2 transition-colors ${isOver ? "bg-primary/5 ring-2 ring-primary/20" : ""}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">{stage.name}</span>
        <span className="text-xs font-bold text-muted-foreground">{stage.totalValue}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[60px] flex-col gap-2">
          {stage.deals.map((deal, i) => (
            <DealCard key={`${stageIndex}-${i}`} deal={deal} id={`${stageIndex}-${i}`} bgColor={stage.bgColor} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

export default function SalesPipeline({
  config,
  title,
}: {
  config: SalesPipelineConfig;
  title?: string;
}) {
  const [stages, setStages] = useState<Stage[]>(initialStages);
  const [activeDeal, setActiveDeal] = useState<{ deal: Deal; bgColor: string } | null>(null);
  const [overStageIdx, setOverStageIdx] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const totalPipeline = "$148,900";
  const weightedPipeline = "$108,420";

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.deal) {
      const stageIdx = parseInt(String(event.active.id).split("-")[0]);
      setActiveDeal({ deal: data.deal as Deal, bgColor: stages[stageIdx].bgColor });
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over) { setOverStageIdx(null); return; }
    const idx = parseInt(String(over.id).split("-")[0]);
    if (!isNaN(idx)) setOverStageIdx(idx);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDeal(null);
    setOverStageIdx(null);

    if (!over) return;

    const fromStageIdx = parseInt(String(active.id).split("-")[0]);
    const fromDealIdx = parseInt(String(active.id).split("-")[1]);
    const toStageIdx = parseInt(String(over.id).split("-")[0]);

    if (fromStageIdx === toStageIdx) return;

    const deal = stages[fromStageIdx].deals[fromDealIdx];
    if (!deal) return;

    setStages((prev) => {
      const next = prev.map((s, i) => {
        if (i === fromStageIdx) return { ...s, deals: s.deals.filter((_, j) => j !== fromDealIdx) };
        if (i === toStageIdx) return { ...s, deals: [...s.deals, deal] };
        return s;
      });
      return next;
    });

    toast.success(`Moved "${deal.name}" to ${stages[toStageIdx].name}`, {
      description: `Agent notification: Deal "${deal.name}" moved from ${stages[fromStageIdx].name} to ${stages[toStageIdx].name}`,
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">{title ?? "Sales Pipeline"}</CardTitle>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Pipeline: <strong className="text-foreground">{totalPipeline}</strong></span>
          <span>Weighted: <strong className="text-foreground">{weightedPipeline}</strong></span>
        </div>
      </CardHeader>
      <CardContent>
        {/* Funnel bar */}
        <div className="mb-4 flex h-8 overflow-hidden rounded-md">
          {stages.map((stage, i) => {
            const widths = [18, 16, 21, 6, 39];
            return (
              <div
                key={stage.name}
                className={`flex items-center justify-center ${stage.color} transition-all`}
                style={{ width: `${widths[i]}%`, opacity: 0.8 }}
              >
                <span className="text-[10px] font-medium text-white drop-shadow-sm">{stage.name}</span>
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
          <div className="flex gap-3 overflow-x-auto pb-2">
            {stages.map((stage, i) => (
              <StageColumn
                key={stage.name}
                stage={stage}
                stageIndex={i}
                isOver={overStageIdx === i}
              />
            ))}
          </div>
          <DragOverlay>
            {activeDeal ? (
              <div className={`w-[180px] rounded-md border-l-4 p-2.5 shadow-lg ${activeDeal.bgColor}`}>
                <div className="text-xs font-medium">{activeDeal.deal.name}</div>
                <div className="text-[11px] text-muted-foreground">{activeDeal.deal.client}</div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-xs font-bold">{activeDeal.deal.value}</span>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </CardContent>
    </Card>
  );
}
