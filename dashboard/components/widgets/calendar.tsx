"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CalendarConfig {
  source?: string;
  view?: string;
  [key: string]: unknown;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function buildMonthGrid() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();

  const cells: Array<{ day: number | null; isToday: boolean }> = [];
  for (let i = 0; i < firstDay; i++) cells.push({ day: null, isToday: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, isToday: d === today });
  return { cells, label: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
}

export default function Calendar({
  config,
  title,
}: {
  config: CalendarConfig;
  title?: string;
}) {
  const { cells, label } = buildMonthGrid();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title ?? label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-7 gap-px text-center text-xs">
          {DAYS.map((d) => (
            <div key={d} className="py-1 font-medium text-muted-foreground">{d}</div>
          ))}
          {cells.map((cell, i) => (
            <div
              key={i}
              className={`flex h-8 items-center justify-center rounded-md ${
                cell.isToday
                  ? "bg-primary text-primary-foreground font-semibold"
                  : cell.day
                    ? "hover:bg-muted/50"
                    : ""
              }`}
            >
              {cell.day ?? ""}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
