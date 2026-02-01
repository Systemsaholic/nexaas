import { ComponentType } from "react"

const widgetRegistry: Record<string, () => Promise<{ default: ComponentType<{ config: Record<string, unknown>; title?: string }> }>> = {
  "stat-cards": () => import("@/components/widgets/stat-cards"),
  "agent-tree": () => import("@/components/widgets/agent-tree"),
  "agent-chat": () => import("@/components/widgets/agent-chat"),
  "event-timeline": () => import("@/components/widgets/event-timeline"),
  "queue-status": () => import("@/components/widgets/queue-status"),
  "registry-table": () => import("@/components/widgets/registry-table"),
  "data-table": () => import("@/components/widgets/data-table"),
  "email-preview": () => import("@/components/widgets/email-preview"),
  "email-list": () => import("@/components/widgets/email-list"),
  "email-drafts": () => import("@/components/widgets/email-drafts"),
  "social-media-preview": () => import("@/components/widgets/social-media-preview"),
  "pipeline-board": () => import("@/components/widgets/pipeline-board"),
  "draft-list": () => import("@/components/widgets/draft-list"),
  "social-posts-grid": () => import("@/components/widgets/social-posts-grid"),
  "campaign-funnel": () => import("@/components/widgets/campaign-funnel"),
  "quick-actions": () => import("@/components/widgets/quick-actions"),
  "automation-panel": () => import("@/components/widgets/automation-panel"),
  "analytics-charts": () => import("@/components/widgets/analytics-charts"),
  "sales-pipeline": () => import("@/components/widgets/sales-pipeline"),
  "chart": () => import("@/components/widgets/chart"),
  "calendar": () => import("@/components/widgets/calendar"),
  "markdown-viewer": () => import("@/components/widgets/markdown-viewer"),
  "agent-skill-bar": () => import("@/components/widgets/agent-skill-bar"),
  "content-editor": () => import("@/components/widgets/content-editor"),
}

export function getWidget(type: string) {
  return widgetRegistry[type] ?? null
}

export function getAvailableWidgets(): string[] {
  return Object.keys(widgetRegistry)
}

export default widgetRegistry
