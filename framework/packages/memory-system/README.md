# Memory System

Persistent YAML-based memory that syncs to the event engine on startup.

## How It Works

Memory files live in `workspace/memory/` and are read by the engine at startup. Each item is upserted into the events table:

- `followups.yaml` → one-time events (`condition_type: once`)
- `checks.yaml` → recurring events (`condition_type: interval`)

This allows agents to schedule future work by writing YAML files that the engine picks up automatically.

## File Structure

```
workspace/memory/
├── followups.yaml    # One-time tasks
└── checks.yaml       # Recurring checks
```

## Followup Format

```yaml
followups:
  - id: followup-client-review
    description: Review client deliverables
    agent: director
    due: "2025-03-01T09:00:00Z"
    action:
      prompt: "Review pending deliverables for all active clients"
```

## Check Format

```yaml
checks:
  - id: check-inbox
    description: Check email inbox for new messages
    agent: email-manager
    interval: 3600
    action:
      prompt: "Check the inbox for new client messages and flag urgent items"
```

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | no | Stable ID for upsert (auto-generated if omitted) |
| `description` | string | yes | What this memory item does |
| `agent` | string | no | Target agent name |
| `due` | string | no | ISO timestamp (followups only) |
| `interval` | int | no | Seconds between runs (checks only, default: 3600) |
| `action` | string/object | yes | Prompt string or `{prompt: "..."}` |
