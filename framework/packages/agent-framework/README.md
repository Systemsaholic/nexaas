# Agent Framework

The agent system discovers, merges, and serves agent configurations as a hierarchical tree.

## How It Works

Agents are defined as directories containing a `config.yaml` and optional `prompt.md`. The engine scans two locations:

1. `framework/agents/` — default agents shipped with Nexaas
2. `workspace/agents/` — workspace-specific agents

When both define an agent with the same name, the workspace version wins.

## File Structure

```
agents/
└── my-agent/
    ├── config.yaml    # Required: name, role, description, capabilities
    └── prompt.md      # Optional: system prompt for Claude sessions
```

## Config Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Agent slug (must match directory name) |
| `role` | string | yes | Human-readable role title |
| `description` | string | yes | What this agent does |
| `capabilities` | list | yes | e.g., `[chat, delegate, monitor]` |
| `parent` | string | no | Parent agent name (creates hierarchy) |
| `sub_agents` | list | no | Child agent names (informational) |

## API Endpoints

- `GET /api/agents` — returns the full agent tree
- `GET /api/agents/{name}` — returns a single agent by name

## Integration Points

- **Event Engine** — events can target a specific agent via the `agent` field
- **Chat Proxy** — chat sessions are scoped to an agent
- **Dashboard** — the `agent-tree` component visualizes the hierarchy
