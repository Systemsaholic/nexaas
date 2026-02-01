"use client"

import { useParams } from "next/navigation"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import PageRenderer from "@/components/layout/page-renderer"

export default function DynamicPage() {
  const params = useParams()
  const pageId = params.page as string
  const { workspace, activePerspectiveId } = useWorkspaceStore()

  const perspective = workspace?.perspectives?.find((p) => p.id === activePerspectiveId)
  const pageConfig = perspective?.pages?.find((p) => p.id === pageId)

  if (!pageConfig) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Page not found: {pageId}
      </div>
    )
  }

  return (
    <div>
      <div className="border-b px-6 py-3">
        <h1 className="text-lg font-semibold">
          {pageConfig.icon && <span className="mr-2">{pageConfig.icon}</span>}
          {pageConfig.name}
        </h1>
      </div>
      <PageRenderer components={pageConfig.components ?? []} />
    </div>
  )
}
