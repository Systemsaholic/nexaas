"use client"

import Link from "next/link"
import { useParams, usePathname } from "next/navigation"
import { useWorkspaceStore } from "@/lib/stores/workspace-store"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

export default function Sidebar() {
  const { workspace, activePerspectiveId } = useWorkspaceStore()
  const params = useParams()
  const pathname = usePathname()
  const workspaceId = params.id as string

  const perspective = workspace?.perspectives?.find((p) => p.id === activePerspectiveId)
  const pages = perspective?.pages ?? []

  return (
    <aside className="w-56 border-r bg-muted/30 flex flex-col">
      <ScrollArea className="flex-1 px-2 py-3">
        <nav className="flex flex-col gap-0.5">
          {pages.map((page) => {
            const href = `/workspace/${workspaceId}/${page.id}`
            const isActive = pathname === href || (pathname === `/workspace/${workspaceId}` && page.id === perspective?.default_page)

            return (
              <Link
                key={page.id}
                href={href}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                {page.icon && <span>{page.icon}</span>}
                {page.name}
              </Link>
            )
          })}
        </nav>
      </ScrollArea>
    </aside>
  )
}
