"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"

export default function Home() {
  const router = useRouter()
  const { activeWorkspaceId, gateways, addGateway } = useWorkspaceStore()

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

  useEffect(() => {
    if (activeWorkspaceId) {
      router.replace(`/workspace/${activeWorkspaceId}`)
    } else if (gateways.size > 0) {
      const firstId = gateways.keys().next().value
      if (firstId) router.replace(`/workspace/${firstId}`)
    }
  }, [activeWorkspaceId, gateways, router])

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold">AI Mission Control</h1>
        <p className="text-muted-foreground">No workspace configured. Add a gateway connection to get started.</p>
      </div>
    </div>
  )
}
