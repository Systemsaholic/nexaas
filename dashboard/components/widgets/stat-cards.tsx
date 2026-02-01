"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StatCard {
  label: string;
  value: string | number;
  icon?: string;
  change?: string;
  color?: string;
}

interface StatCardsConfig {
  cards?: StatCard[];
  [key: string]: unknown;
}

const placeholderCards: StatCard[] = [
  { label: "Total Agents", value: "—", change: "+2", color: "text-emerald-500" },
  { label: "Tasks Running", value: "—", change: "+5" },
  { label: "Success Rate", value: "—", change: "+1.2%" },
  { label: "Avg Latency", value: "—" },
];

export default function StatCards({
  config,
  title,
}: {
  config: StatCardsConfig;
  title?: string;
}) {
  const cards = config.cards ?? placeholderCards;

  return (
    <Card>
      {title && (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((card, i) => (
          <div
            key={i}
            className="flex flex-col gap-1 rounded-lg border p-4"
          >
            {card.icon && (
              <span className="text-lg text-muted-foreground">{card.icon}</span>
            )}
            <span className="text-2xl font-bold">
              {card.value}
            </span>
            <span className="text-xs text-muted-foreground">{card.label}</span>
            {card.change && (
              <span className={`text-xs font-medium ${card.color ?? "text-muted-foreground"}`}>
                {card.change}
              </span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
