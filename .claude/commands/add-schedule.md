# Add Scheduled Task

Add a recurring check or one-time followup.

## Step 1: Task Type

Ask: "Is this a recurring task or a one-time task?"

- **Recurring** → goes in `workspace/memory/checks.yaml`
- **One-time** → goes in `workspace/memory/followups.yaml`

## Step 2: Task Details

Ask:
1. **Task ID** — unique identifier, lowercase-hyphenated (e.g., `daily-inbox-check`)
2. **Description** — What does this task do?
3. **Agent** — Which agent handles this?

List available agents:
```bash
ls workspace/agents/
```

## Step 3: Timing

**For recurring tasks:**

Ask: "How often should this run?"

| Interval | Seconds |
|----------|---------|
| Every hour | 3600 |
| Every 6 hours | 21600 |
| Every 12 hours | 43200 |
| Daily | 86400 |
| Weekly | 604800 |

Or let them specify custom seconds.

**For one-time tasks:**

Ask: "When should this run?"

Accept ISO datetime (e.g., `2025-04-01T09:00:00Z`) or relative (e.g., "tomorrow 9am", "next Monday").

## Step 4: Task Instructions

Ask: "What should the agent do?"

Help them write a clear prompt:
- Be specific about the task
- Mention any registries to check/update
- Specify output format if needed

Example:
```
Scan the inbox for new messages. For each urgent message, create an entry in the tickets registry. Summarize findings with count of urgent vs normal messages.
```

## Step 5: Create Entry

**For recurring (`workspace/memory/checks.yaml`):**

Read existing file, add new entry:

```yaml
checks:
  # ... existing checks ...
  - id: {task-id}
    description: {description}
    agent: {agent-name}
    interval: {seconds}
    action:
      prompt: "{task instructions}"
```

**For one-time (`workspace/memory/followups.yaml`):**

```yaml
followups:
  # ... existing followups ...
  - id: {task-id}
    description: {description}
    agent: {agent-name}
    due: "{ISO datetime}"
    action:
      prompt: "{task instructions}"
```

## Step 6: Restart Engine

Tell operator:

```
Task added! Restart engine to load the new schedule:

docker compose restart engine
```

## Step 7: Summary

```
Scheduled task created:
- ID: {task-id}
- Type: {recurring/one-time}
- Agent: {agent-name}
- Timing: {interval or due date}
- File: workspace/memory/{checks or followups}.yaml

After engine restart, check status:
  curl -H "Authorization: Bearer $API_KEY" localhost:8400/api/events | jq '.[] | select(.id=="{task-id}")'
```
