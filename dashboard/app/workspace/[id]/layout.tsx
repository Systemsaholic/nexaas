"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import { useOpsStore } from "@/lib/stores/ops-store"
import WorkspaceSwitcher from "@/components/layout/workspace-switcher"
import PerspectiveSwitcher from "@/components/layout/perspective-switcher"
import Sidebar from "@/components/layout/sidebar"

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams()
  const workspaceId = params.id as string
  const { activeWorkspaceId, gateways, addGateway, setActiveWorkspace, connectionStatus } = useWorkspaceStore()
  const unacknowledgedCriticalCount = useOpsStore((s) => s.unacknowledgedCriticalCount)

  // Subscribe to SSE for critical ops alerts
  useEffect(() => {
    if (connectionStatus !== "connected") return
    const client = useWorkspaceStore.getState().getActiveEngineClient()
    if (!client) return
    // Fetch initial alerts for badge count
    useOpsStore.getState().fetchAlerts()
    const es = client.subscribeEvents((event) => {
      const data = event as unknown as Record<string, unknown>
      if (data.type === "ops.alert") {
        const payload = data.data as Record<string, unknown>
        if (payload.severity === "critical") {
          toast.error(payload.message as string, { description: payload.category as string })
          useOpsStore.getState().fetchAlerts()
        }
      }
    })
    return () => es.close()
  }, [connectionStatus])

  // Bootstrap default gateway from server-side config endpoint
  useEffect(() => {
    if (gateways.size > 0) return
    fetch("/api/engine/config")
      .then((res) => res.json())
      .then((data: { id: string; name: string; url: string; apiKey: string }) => {
        if (data.url && data.apiKey) {
          addGateway(data.id, { url: data.url, apiKey: data.apiKey, name: data.name })
        }
      })
      .catch((err) => console.error("Failed to fetch gateway config:", err))
  }, [gateways.size, addGateway])

  // Connect to workspace once gateway is registered
  useEffect(() => {
    if (workspaceId && gateways.has(workspaceId) && workspaceId !== activeWorkspaceId) {
      setActiveWorkspace(workspaceId)
    }
  }, [workspaceId, activeWorkspaceId, gateways, setActiveWorkspace])

  return (
    <div className="flex flex-col h-screen">
      <header className="h-12 border-b flex items-center justify-between px-4 shrink-0">
        <WorkspaceSwitcher />
        <div className="flex items-center gap-2">
          {unacknowledgedCriticalCount > 0 && (
            <a href="/admin/ops" className="relative flex items-center justify-center w-6 h-6" title="Critical ops alerts">
              <span className="absolute inline-flex h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
            </a>
          )}
          <PerspectiveSwitcher />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          {connectionStatus === "error" ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Failed to connect to gateway
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  )
}
