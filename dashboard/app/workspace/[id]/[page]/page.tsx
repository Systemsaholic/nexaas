"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import PageRenderer from "@/components/layout/page-renderer"

export default function DynamicPage() {
  const params = useParams()
  const pageId = params.page as string
  const { workspace, activePerspectiveId, setActivePerspective } = useWorkspaceStore()

  // Find page in current perspective
  const currentPerspective = workspace?.perspectives?.find((p) => p.id === activePerspectiveId)
  let pageConfig = currentPerspective?.pages?.find((p) => p.id === pageId)

  // If not found, search all perspectives and switch to the correct one
  const correctPerspective = !pageConfig
    ? workspace?.perspectives?.find((p) => p.pages?.some((page) => page.id === pageId))
    : null

  useEffect(() => {
    if (correctPerspective && correctPerspective.id !== activePerspectiveId) {
      setActivePerspective(correctPerspective.id)
    }
  }, [correctPerspective, activePerspectiveId, setActivePerspective])

  // Use page from correct perspective if found
  if (!pageConfig && correctPerspective) {
    pageConfig = correctPerspective.pages?.find((p) => p.id === pageId)
  }

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
