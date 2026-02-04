# Dashboard System

The Next.js frontend that visualizes workspaces, agents, registries, and operational data.

## How It Works

The dashboard reads workspace configuration from the engine API and renders perspectives, pages, and components dynamically. Layout is driven entirely by `workspace.yaml`.

## Key Concepts

- **Perspectives** — top-level nav sections (e.g., Operations, Marketing)
- **Pages** — views within a perspective, each with a layout (`grid` or `single`)
- **Components** — widgets placed on pages with column spans (1–12)

## Component Types

| Type | Description |
|---|---|
| `agent-tree` | Hierarchical agent visualization |
| `registry-table` | Tabular display of registry entries |
| `stat-cards` | Key metrics in card format |
| `event-timeline` | Chronological event display |
| `queue-status` | Job queue monitoring |
| `quick-actions` | Action buttons for common tasks |

## Configuration

All dashboard layout is defined in `workspace.yaml` under `perspectives`. No dashboard code changes are needed to add new views.

## Integration Points

- **Engine API** — all data fetched via REST endpoints
- **WebSocket** — real-time chat via `/ws/chat`
- **Auth** — JWT-based with httpOnly cookie storage
