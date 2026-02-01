"use client"

import { Suspense, lazy, useMemo } from "react"
import { getWidget } from "@/components/widget-registry"
import { Skeleton } from "@/components/ui/skeleton"
import type { ComponentConfig } from "@/lib/types"

interface PageRendererProps {
  components: ComponentConfig[]
}

export default function PageRenderer({ components }: PageRendererProps) {
  return (
    <div className="grid grid-cols-12 gap-4 p-4">
      {components.map((comp, i) => (
        <div key={i} style={{ gridColumn: `span ${comp.span ?? 12} / span ${comp.span ?? 12}` }}>
          <WidgetLoader type={comp.type} title={comp.title} config={comp.config ?? {}} />
        </div>
      ))}
    </div>
  )
}

function WidgetLoader({ type, title, config }: { type: string; title?: string; config: Record<string, unknown> }) {
  const Widget = useMemo(() => {
    const loader = getWidget(type)
    if (!loader) return null
    return lazy(loader)
  }, [type])

  if (!Widget) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
        Unknown widget: {type}
      </div>
    )
  }

  return (
    <Suspense fallback={<Skeleton className="h-48 w-full rounded-lg" />}>
      <Widget config={config} title={title} />
    </Suspense>
  )
}
