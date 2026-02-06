# Add Flow

Create a new automation flow interactively.

## Pre-flight: Detect Deployment Type

```bash
docker compose ps 2>/dev/null | grep -q "engine" && echo "docker" || echo "local"
systemctl is-active nexaas-engine 2>/dev/null && echo "systemd"
pgrep -f "python server.py" && echo "local-process"
```

---

## Phase 1: Flow Purpose

Ask: "What should this flow automate?"

Get:
1. **Name** — Short descriptive name (e.g., "Weekly Report", "Client Onboarding")
2. **Description** — What the flow does in one sentence
3. **Goal** — What's the deliverable? (report, notification, data update, etc.)

Generate an ID from the name (lowercase, hyphenated).

---

## Phase 2: Trigger

Ask: "How should this flow be triggered?"

Options:
1. **Schedule (Cron)** — Runs at specific times
2. **Schedule (Interval)** — Runs every N minutes/hours
3. **Webhook** — Triggered by external HTTP request
4. **After another flow** — Chains from existing flow
5. **Manual only** — Only runs when explicitly triggered

### If Cron:
Ask for schedule in natural language:
- "Every day at 9 AM"
- "Every Monday at 8 AM"
- "First of the month at midnight"
- "Every Friday at 5 PM"

Convert to cron expression.

### If Interval:
Ask: "How often?" (e.g., "every hour", "every 30 minutes", "every 4 hours")

### If Webhook:
Generate webhook path: `/flows/{flow-id}/trigger`

Ask: "What data will the webhook receive?" (optional payload schema)

### If Flow Chain:
List existing flows and ask which one triggers this flow.
Ask: "Run on success, failure, or both?"

---

## Phase 3: Steps

Ask: "What steps should this flow perform?"

Walk through each step:

### For each step:

1. **What does this step do?** (describe in plain language)

2. **What type of action?**
   - **Agent task** — Have an AI agent do something
   - **Run a skill** — Execute a defined skill
   - **Run a script** — Execute a shell command
   - **Call a webhook** — Make an HTTP request
   - **Run another flow** — Trigger a sub-flow

3. **Configure the action:**

   **If Agent task:**
   - Which agent? (list available agents)
   - What prompt/instructions?

   **If Skill:**
   - Which skill? (list available skills)
   - What input?

   **If Script:**
   - What command?
   - Timeout? (default 60s)

   **If Webhook:**
   - URL?
   - Method? (GET, POST, etc.)
   - Headers? (optional)
   - Body? (optional)

   **If Sub-flow:**
   - Which flow?
   - Wait for completion?

4. **Dependencies:**
   - Does this step use output from a previous step?
   - Map: `{{steps.previous-step-id.output}}`

5. **Error handling:**
   - Continue on error?
   - Retry? How many times?

Ask: "Add another step?" Repeat until done.

---

## Phase 4: Dependencies Check

Based on the steps, identify required:
- Agents
- Registries
- Skills
- MCP servers
- Environment variables

Show the list:

```
This flow requires:
- Agents: report-generator, data-analyst
- Registries: tasks, metrics
- Skills: generate-report
- MCP Servers: filesystem
- Env Vars: SLACK_WEBHOOK_URL
```

Check if each exists. For missing items:
- Offer to create agents/registries/skills
- Note env vars that need to be set

---

## Phase 5: Output Definition

Ask: "What does this flow produce?"

Options:
1. **Report** — Document or summary
2. **Email** — Sends an email
3. **Notification** — Slack/Teams/Telegram message
4. **Data Update** — Creates/updates registry data
5. **File** — Creates a file
6. **API Call** — Updates external system

Get destination details if applicable.

---

## Phase 6: Generate Flow File

Create `workspace/flows/{flow-id}.yaml`:

```yaml
id: {flow-id}
name: {name}
description: {description}

trigger:
  type: {trigger-type}
  {trigger-config}

requires:
  agents: [{list}]
  registries: [{list}]
  skills: [{list}]
  mcp_servers: [{list}]
  env: [{list}]

steps:
  {generated-steps}

output:
  type: {output-type}
  description: {output-description}
```

Show the generated YAML and ask: "Does this look right?"

Allow edits before saving.

---

## Phase 7: Validation

Validate the flow:

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/{flow-id}/validate
```

Report any issues.

---

## Phase 8: Test Run

Ask: "Would you like to test this flow now?"

If yes:
```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/{flow-id}/trigger
```

Show output and ask if adjustments needed.

---

## Phase 9: Summary

```
========================================
  Flow Created: {name}
========================================

ID:          {flow-id}
Trigger:     {trigger description}
Steps:       {count} steps
Output:      {output type}

File: workspace/flows/{flow-id}.yaml

Trigger manually:
  curl -X POST -H "Authorization: Bearer $API_KEY" \
    http://localhost:8400/api/flows/{flow-id}/trigger

{If webhook trigger:}
External webhook URL:
  POST http://your-domain:8400/api/flows/{flow-id}/trigger

View runs:
  curl -H "Authorization: Bearer $API_KEY" \
    http://localhost:8400/api/flows/{flow-id}/runs

Need to edit? Just modify the YAML file directly.
========================================
```

---

## Example Conversation

**Claude:** What should this flow automate?

**User:** Send a weekly summary of completed tasks to Slack every Friday

**Claude:** Got it. I'll create a flow called "Weekly Task Summary".

For the trigger, you mentioned "every Friday" - what time should it run?

**User:** 5 PM

**Claude:** Perfect. Now let's define the steps.

**Step 1:** What's the first thing this flow should do?

**User:** Query the tasks registry for tasks completed this week

**Claude:** I'll use the task-manager agent for this. Here's what I have:

```yaml
- id: gather-tasks
  action: claude_chat
  agent: task-manager
  config:
    prompt: "Query the tasks registry for all tasks completed this week. Return a summary."
```

What's the next step?

**User:** Send it to Slack

**Claude:** I'll add a webhook step. Do you have a SLACK_WEBHOOK_URL in your environment?

**User:** Yes

**Claude:** Great. Here's the complete flow:

```yaml
id: weekly-task-summary
name: Weekly Task Summary
description: Send completed tasks summary to Slack every Friday at 5 PM

trigger:
  type: cron
  expr: "0 17 * * 5"

requires:
  agents: [task-manager]
  registries: [tasks]
  env: [SLACK_WEBHOOK_URL]

steps:
  - id: gather-tasks
    action: claude_chat
    agent: task-manager
    config:
      prompt: "Query the tasks registry for all tasks completed this week. Return a summary."

  - id: send-slack
    action: webhook
    config:
      url: "{{env.SLACK_WEBHOOK_URL}}"
      method: POST
      body:
        text: "Weekly Task Summary:\n{{steps.gather-tasks.output}}"

output:
  type: notification
  description: Weekly task summary posted to Slack
```

Does this look right?

---

## Notes

- Keep flows focused — one flow, one outcome
- Chain flows for complex workflows
- Always test with manual trigger first
- Use environment variables for URLs and secrets
- Check that required agents/registries exist before creating flow
