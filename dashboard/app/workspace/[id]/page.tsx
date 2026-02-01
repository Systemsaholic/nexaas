"use client"

import { useEffect } from "react"
import { useRouter, useParams } from "next/navigation"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"

export default function WorkspaceDefaultPage() {
  const router = useRouter()
  const params = useParams()
  const workspaceId = params.id as string
  const { workspace, activePerspectiveId } = useWorkspaceStore()

  useEffect(() => {
    const perspective = workspace?.perspectives?.find((p) => p.id === activePerspectiveId)
    if (perspective?.default_page) {
      router.replace(`/workspace/${workspaceId}/${perspective.default_page}`)
    }
  }, [workspace, activePerspectiveId, workspaceId, router])

  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      Loading workspace...
    </div>
  )
}
