# Add Event

You are scheduling a new event in the workspace event engine. Walk through each step interactively.

## Step 1: Event Type

Ask the user what kind of event to create:

| Type | Description | Example |
|------|-------------|---------|
| **cron** | Runs on a cron schedule | "Every weekday at 9am" |
| **interval** | Runs every N minutes | "Every 30 minutes" |
| **one_time** | Runs once at a specific time | "Tomorrow at 3pm UTC" |

Also ask for an **event name** (descriptive identifier, e.g., "morning-email-digest").

## Step 2: Configure Condition

Based on the event type:

### Cron
Ask for the schedule. Help the user build the cron expression:
- "Every day at 9am" -> `0 9 * * *`
- "Every weekday at 8:30am" -> `30 8 * * 1-5`
- "Every Monday at noon" -> `0 12 * * 1`
- "First of every month" -> `0 0 1 * *`

Show the resulting cron expression and confirm it matches their intent.

### Interval
Ask: "How many minutes between each run?"
Validate it's a positive integer.

### One-time
Ask for the specific datetime. Accept natural language and convert to ISO 8601 UTC format. Confirm the converted time with the user.

## Step 3: Configure Action

Ask what should happen when the event fires:

| Action Type | Description |
|-------------|-------------|
| **claude_chat** | Send a prompt to Claude with workspace context |
| **script** | Execute a shell command or script |
| **webhook** | Send an HTTP request to a URL |

### claude_chat
Ask for:
- **Prompt** - What should Claude do? (e.g., "Check for new emails and summarize them")
- **Agent** (optional) - Which agent context to use? List available agents from `agents/`.
- **Model** (optional) - Which model to use (default: claude-sonnet-4-20250514)

### script
Ask for:
- **Command** - The shell command to run
- **Working directory** (optional, defaults to workspace root)
- **Timeout** in seconds (default: 300)

### webhook
Ask for:
- **URL** - The endpoint to call
- **Method** - GET, POST, PUT (default: POST)
- **Headers** (optional)
- **Body template** (optional)

## Step 4: Execution Settings

Ask for (provide defaults):
- **Priority** (1-10, default: 5) - Higher priority jobs run first
- **Concurrency key** (optional) - Events with the same key won't run simultaneously
- **Max retries** (default: 3) - How many times to retry on failure

## Step 5: Insert Event

Insert the event into the database. Use the gateway API if running, otherwise insert directly into SQLite.

### Via API (preferred):
```bash
curl -X POST http://localhost:8080/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "name": "{event_name}",
    "type": "{cron|interval|one_time}",
    "condition": "{cron_expr|interval_minutes|iso_datetime}",
    "action_type": "{claude_chat|script|webhook}",
    "action_config": {action_config_json},
    "priority": {priority},
    "concurrency_key": "{key_or_null}",
    "max_retries": {max_retries}
  }'
```

### Via direct SQLite (fallback):
```sql
INSERT INTO events (name, type, condition, action_type, action_config, priority, concurrency_key, max_retries)
VALUES ('{name}', '{type}', '{condition}', '{action_type}', '{action_config_json}', {priority}, '{key}', {retries});
```

Use the database at `{workspace_root}/data/mission_control.db`.

## Completion

Summarize:
- Event name and type
- Schedule/condition (human-readable)
- Action description
- Priority and retry settings
- Suggest checking `/workspace-status` to verify, or adding more events
