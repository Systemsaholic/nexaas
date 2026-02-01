"use client"

import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"

export default function WorkspaceSwitcher() {
  const { gateways, activeWorkspaceId, setActiveWorkspace, connectionStatus } = useWorkspaceStore()

  const gatewayList = Array.from(gateways.entries())

  if (gatewayList.length <= 1) {
    const name = gatewayList[0]?.[1]?.name ?? "No workspace"
    return (
      <div className="flex items-center gap-2 px-2">
        <span className="text-sm font-medium truncate">{name}</span>
        <ConnectionBadge status={connectionStatus} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={activeWorkspaceId ?? ""} onValueChange={setActiveWorkspace}>
        <SelectTrigger className="w-[180px] h-8">
          <SelectValue placeholder="Select workspace" />
        </SelectTrigger>
        <SelectContent>
          {gatewayList.map(([id, gw]) => (
            <SelectItem key={id} value={id}>
              {gw.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConnectionBadge status={connectionStatus} />
    </div>
  )
}

function ConnectionBadge({ status }: { status: string }) {
  const variant = status === "connected" ? "default" : status === "error" ? "destructive" : "secondary"
  return (
    <Badge variant={variant} className="text-[10px] px-1.5 py-0">
      {status}
    </Badge>
  )
}
