# Playbook 05: Memory System

Use the memory system to schedule followups and recurring checks.

## Prerequisites

- Workspace deployed and engine running
- `workspace/memory/` directory exists with `followups.yaml` and `checks.yaml`

## Adding a Followup

Followups are one-time tasks. Edit `workspace/memory/followups.yaml`:

```yaml
followups:
  - id: review-q1-results
    description: Review Q1 campaign results with the team
    agent: director
    due: "2025-04-01T09:00:00Z"
    action:
      prompt: "Review Q1 results and prepare a summary for the team"
```

## Adding a Check

Checks are recurring tasks. Edit `workspace/memory/checks.yaml`:

```yaml
checks:
  - id: daily-inbox-check
    description: Check for new messages daily
    agent: email-manager
    interval: 86400
    action:
      prompt: "Check the inbox and flag any urgent messages"
```

## How It Syncs

Memory files are read on engine startup and upserted into the events table:

- Followups become `condition_type: once` events
- Checks become `condition_type: interval` events

The `id` field ensures items are updated (not duplicated) on restart.

## Verification

After restarting the engine:

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/events
```

Your memory items should appear as events with `type: memory_followup` or `type: memory_check`.

## Notes

- Always provide stable `id` values to prevent duplicates
- The `due` field is optional for followups (defaults to 5 minutes from startup)
- The `interval` field defaults to 3600 seconds (1 hour) for checks
- The `action` field can be a string or an object with a `prompt` key
