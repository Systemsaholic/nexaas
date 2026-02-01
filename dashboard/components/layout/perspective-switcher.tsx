"use client"

import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default function PerspectiveSwitcher() {
  const { workspace, activePerspectiveId, setActivePerspective } = useWorkspaceStore()

  const perspectives = workspace?.perspectives ?? []

  if (perspectives.length <= 1) return null

  return (
    <Tabs value={activePerspectiveId ?? ""} onValueChange={setActivePerspective}>
      <TabsList className="h-8">
        {perspectives.map((p) => (
          <TabsTrigger key={p.id} value={p.id} className="text-xs px-3">
            {p.icon && <span className="mr-1">{p.icon}</span>}
            {p.name}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
