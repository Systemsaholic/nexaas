# Playbook 06: Custom Dashboard

Customize your dashboard layout by editing `workspace.yaml`.

## Prerequisites

- Workspace deployed and engine running

## Structure

```yaml
perspectives:
  - id: my-view
    name: My View
    icon: layout
    default_page: overview
    pages:
      - id: overview
        name: Overview
        icon: "📊"
        layout: grid
        components:
          - type: agent-tree
            title: Team
            span: 6
          - type: stat-cards
            title: Metrics
            span: 6
```

## Adding a Perspective

Add a new entry to the `perspectives` list in `workspace.yaml`:

```yaml
- id: sales
  name: Sales
  icon: dollar-sign
  default_page: pipeline
  pages:
    - id: pipeline
      name: Pipeline
      icon: "🔄"
      layout: grid
      components:
        - type: registry-table
          title: Sales Pipeline
          span: 12
          config:
            registry: pipeline
```

## Available Component Types

| Type | Description | Common Config |
|---|---|---|
| `agent-tree` | Agent hierarchy | `show_sub_agents: true` |
| `registry-table` | Registry data table | `registry: name` |
| `stat-cards` | Metric cards | `stats: [...]` |
| `event-timeline` | Event history | `limit: 20` |
| `queue-status` | Job queue | — |
| `quick-actions` | Action buttons | `actions: [...]` |

## Layout

- `layout: grid` — components arranged in a 12-column grid using `span`
- `layout: single` — components stacked vertically

## Verification

Reload the dashboard. Your new perspective should appear in the navigation sidebar.
