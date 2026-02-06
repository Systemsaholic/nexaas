# Playbook 09: Flows

Build multi-step automations that execute a sequence of actions and produce deliverables.

## What is a Flow?

A **Flow** is an automation that:
1. **Triggers** — Starts from a schedule, webhook, or another flow
2. **Executes** — Runs one or more steps (agents, scripts, skills, webhooks)
3. **Delivers** — Produces an output (report, notification, data update, etc.)

Flows can orchestrate agents, scripts, memory, registries, and skills together.

---

## Flow Structure

Flows live in `workspace/flows/` as YAML files:

```yaml
# workspace/flows/weekly-report.yaml
id: weekly-report
name: Weekly Status Report
description: Generate and send weekly status report every Friday

trigger:
  type: cron
  expr: "0 9 * * 5"  # Friday 9 AM

steps:
  - id: gather-data
    action: claude_chat
    agent: report-generator
    config:
      prompt: |
        Query the tasks registry for completed items this week.
        Query the metrics registry for key numbers.
        Compile into a structured summary.

  - id: generate-report
    action: skill
    agent: report-generator
    config:
      skill: generate-report
      input: "{{steps.gather-data.output}}"

  - id: send-email
    action: webhook
    config:
      url: "{{env.EMAIL_WEBHOOK_URL}}"
      method: POST
      body:
        to: "{{env.REPORT_RECIPIENTS}}"
        subject: "Weekly Status Report - {{date.week}}"
        html: "{{steps.generate-report.output}}"

  - id: log-completion
    action: script
    config:
      command: echo "Report sent at $(date)" >> logs/reports.log

output:
  type: email
  description: Weekly status report sent to team
```

---

## Trigger Types

### Schedule (Cron)

```yaml
trigger:
  type: cron
  expr: "0 9 * * 1-5"  # Weekdays at 9 AM
```

Common patterns:
- `0 9 * * *` — Daily at 9 AM
- `0 9 * * 1` — Monday at 9 AM
- `0 */4 * * *` — Every 4 hours
- `0 9 1 * *` — First of month at 9 AM

### Schedule (Interval)

```yaml
trigger:
  type: interval
  seconds: 3600  # Every hour
```

### Webhook

```yaml
trigger:
  type: webhook
  path: /flows/weekly-report/trigger
  # Optional: validate incoming payload
  validate:
    required: ["project_id"]
```

Trigger URL: `POST /api/flows/{flow-id}/trigger`

### Flow Chain (triggered by another flow)

```yaml
trigger:
  type: flow
  after: daily-data-sync  # Run after this flow completes
  condition: success       # Only on success (default)
```

### Manual

```yaml
trigger:
  type: manual  # Only runs when explicitly triggered via API/dashboard
```

---

## Step Types

### Claude Chat

Send a prompt to an agent:

```yaml
- id: analyze
  action: claude_chat
  agent: analyst
  config:
    prompt: "Analyze the sales data and identify trends"
```

### Skill

Execute a defined skill:

```yaml
- id: summarize
  action: skill
  agent: writer
  config:
    skill: summarize-document
    input: "{{steps.fetch-doc.output}}"
```

### Script

Run a shell command:

```yaml
- id: export
  action: script
  config:
    command: python scripts/export_csv.py --date={{date.today}}
    timeout: 120
    cwd: /opt/nexaas/workspace
```

### Webhook

Make an HTTP request:

```yaml
- id: notify
  action: webhook
  config:
    url: https://api.slack.com/webhooks/xxx
    method: POST
    headers:
      Content-Type: application/json
    body:
      text: "Flow completed: {{flow.name}}"
```

### Sub-flow

Trigger another flow and wait:

```yaml
- id: run-cleanup
  action: flow
  config:
    flow_id: cleanup-temp-files
    wait: true  # Wait for completion (default: true)
```

---

## Variables and Context

Flows have access to context variables:

### Step Outputs

Reference previous step results:
```yaml
prompt: "Process this data: {{steps.fetch-data.output}}"
```

### Environment Variables

```yaml
url: "{{env.SLACK_WEBHOOK_URL}}"
```

### Date/Time

```yaml
subject: "Report for {{date.today}}"  # 2025-02-06
filename: "backup-{{date.iso}}.sql"   # 2025-02-06T09:00:00Z
week: "{{date.week}}"                 # 2025-W06
```

### Flow Metadata

```yaml
log: "Flow {{flow.id}} run #{{flow.run_count}}"
```

### Trigger Payload (webhooks)

```yaml
project_id: "{{trigger.payload.project_id}}"
```

---

## Conditional Steps

Skip steps based on conditions:

```yaml
- id: escalate
  action: webhook
  condition: "{{steps.analyze.output}} contains 'URGENT'"
  config:
    url: "{{env.PAGERDUTY_URL}}"
```

Or use `when`:

```yaml
- id: send-slack
  action: webhook
  when:
    - "{{env.SLACK_ENABLED}} == 'true'"
    - "{{steps.check.output}} != 'skip'"
  config:
    url: "{{env.SLACK_WEBHOOK}}"
```

---

## Error Handling

### Retry Steps

```yaml
- id: call-api
  action: webhook
  retry:
    attempts: 3
    backoff: [5, 30, 120]  # seconds
  config:
    url: https://api.example.com/data
```

### Continue on Error

```yaml
- id: optional-notify
  action: webhook
  on_error: continue  # continue | fail (default) | skip-rest
  config:
    url: "{{env.OPTIONAL_WEBHOOK}}"
```

### Error Branch

```yaml
- id: main-task
  action: claude_chat
  on_error: goto:error-handler
  config:
    prompt: "Process the data"

- id: error-handler
  action: webhook
  skip_unless_error: true
  config:
    url: "{{env.ERROR_WEBHOOK}}"
    body:
      error: "{{error.message}}"
      step: "{{error.step_id}}"
```

---

## Deliverables

Define what the flow produces:

```yaml
output:
  type: report
  format: pdf
  destination: registries/reports
  notify:
    - email: team@company.com
    - slack: "#reports"
```

Output types:
- `report` — Document or data summary
- `email` — Email sent
- `notification` — Slack/Teams/Telegram message
- `data` — Registry or database update
- `file` — File created/modified
- `api` — External API updated

---

## Dependencies

Flows can declare what they need:

```yaml
requires:
  agents:
    - report-generator
    - data-analyst
  registries:
    - tasks
    - metrics
  skills:
    - generate-report
  mcp_servers:
    - filesystem
    - fetch
  env:
    - EMAIL_WEBHOOK_URL
    - REPORT_RECIPIENTS
```

The engine validates dependencies before running.

---

## Creating a Flow

### 1. Define the Goal

What triggers it? What should happen? What's the output?

### 2. Create the Flow File

```bash
# Create flows directory if needed
mkdir -p workspace/flows

# Create flow file
cat > workspace/flows/my-flow.yaml << 'EOF'
id: my-flow
name: My Automation Flow
description: What this flow does

trigger:
  type: interval
  seconds: 3600

steps:
  - id: step-1
    action: claude_chat
    agent: default
    config:
      prompt: "Do the thing"

output:
  type: notification
  description: Task completed
EOF
```

### 3. Validate

```bash
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/my-flow/validate
```

### 4. Test Run

```bash
curl -X POST -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/my-flow/trigger
```

### 5. Monitor

```bash
# Check flow runs
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/my-flow/runs

# View specific run
curl -H "Authorization: Bearer $API_KEY" \
  http://localhost:8400/api/flows/my-flow/runs/{run-id}
```

---

## Example Flows

### Daily Inbox Processing

```yaml
id: daily-inbox
name: Daily Inbox Processing
description: Check inbox and categorize emails

trigger:
  type: cron
  expr: "0 8 * * 1-5"

requires:
  agents: [email-manager]
  mcp_servers: [email]

steps:
  - id: fetch-emails
    action: claude_chat
    agent: email-manager
    config:
      prompt: |
        Check the inbox for new emails since yesterday.
        Categorize each as: urgent, followup, info, spam.
        Return a JSON summary.

  - id: handle-urgent
    action: claude_chat
    agent: email-manager
    condition: "{{steps.fetch-emails.output}} contains 'urgent'"
    config:
      prompt: |
        For each urgent email, draft a quick acknowledgment.
        Flag for human review in the tasks registry.

  - id: notify
    action: webhook
    config:
      url: "{{env.SLACK_WEBHOOK}}"
      body:
        text: "Inbox processed: {{steps.fetch-emails.output}}"

output:
  type: notification
  description: Inbox summary sent to Slack
```

### Client Onboarding

```yaml
id: client-onboarding
name: New Client Onboarding
description: Set up new client after signup

trigger:
  type: webhook
  path: /flows/client-onboarding/trigger
  validate:
    required: [client_name, client_email, plan]

requires:
  agents: [client-manager]
  registries: [clients, projects]

steps:
  - id: create-client-record
    action: claude_chat
    agent: client-manager
    config:
      prompt: |
        Add new client to the clients registry:
        - Name: {{trigger.payload.client_name}}
        - Email: {{trigger.payload.client_email}}
        - Plan: {{trigger.payload.plan}}
        - Status: active
        - Start Date: {{date.today}}

  - id: send-welcome
    action: skill
    agent: client-manager
    config:
      skill: send-welcome-email
      input: |
        client_name: {{trigger.payload.client_name}}
        client_email: {{trigger.payload.client_email}}
        plan: {{trigger.payload.plan}}

  - id: create-project
    action: claude_chat
    agent: client-manager
    config:
      prompt: |
        Create initial project in the projects registry:
        - Client: {{trigger.payload.client_name}}
        - Name: Onboarding
        - Status: in_progress
        - Deadline: {{date.plus_days(7)}}

  - id: schedule-followup
    action: claude_chat
    agent: client-manager
    config:
      prompt: |
        Add a followup to memory for 3 days from now:
        "Check in with {{trigger.payload.client_name}} on onboarding progress"

output:
  type: data
  description: Client record, project, and followup created
```

### Weekly Report Chain

```yaml
# Flow 1: Gather data
id: weekly-data-gather
name: Weekly Data Gathering
trigger:
  type: cron
  expr: "0 8 * * 5"  # Friday 8 AM

steps:
  - id: pull-metrics
    action: script
    config:
      command: python scripts/pull_metrics.py --week={{date.week}}

output:
  type: data
  description: Metrics pulled into registry

---
# Flow 2: Generate report (chains from flow 1)
id: weekly-report-generate
name: Weekly Report Generation
trigger:
  type: flow
  after: weekly-data-gather

steps:
  - id: generate
    action: claude_chat
    agent: report-generator
    config:
      prompt: "Generate weekly report from metrics registry"

  - id: save-pdf
    action: skill
    config:
      skill: export-pdf
      input: "{{steps.generate.output}}"

output:
  type: report
  format: pdf

---
# Flow 3: Distribute (chains from flow 2)
id: weekly-report-distribute
name: Weekly Report Distribution
trigger:
  type: flow
  after: weekly-report-generate

steps:
  - id: email
    action: webhook
    config:
      url: "{{env.EMAIL_API}}"
      body:
        to: "{{env.REPORT_RECIPIENTS}}"
        attachment: "{{steps.save-pdf.output}}"

output:
  type: email
  description: Report sent to stakeholders
```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/flows` | GET | List all flows |
| `/api/flows/{id}` | GET | Get flow details |
| `/api/flows/{id}/validate` | GET | Validate flow config |
| `/api/flows/{id}/trigger` | POST | Trigger flow manually |
| `/api/flows/{id}/runs` | GET | List flow runs |
| `/api/flows/{id}/runs/{run}` | GET | Get run details |
| `/api/flows/{id}/runs/{run}/cancel` | POST | Cancel running flow |
| `/api/flows/{id}/enable` | POST | Enable scheduled flow |
| `/api/flows/{id}/disable` | POST | Disable scheduled flow |

---

## Dashboard

View and manage flows in the dashboard:

1. **Flows List** — See all flows, status, last run
2. **Flow Detail** — View steps, edit config, see run history
3. **Run View** — Step-by-step execution log with outputs
4. **Trigger** — Manual trigger with optional payload
5. **Schedule** — View/edit trigger schedule

---

## Best Practices

1. **Start simple** — Single step first, add complexity as needed
2. **Use meaningful IDs** — `gather-sales-data` not `step-1`
3. **Validate early** — Check dependencies before running
4. **Log outputs** — Use the last step to record what was done
5. **Handle errors** — Always have an error notification path
6. **Keep secrets in env** — Never hardcode credentials in flows
7. **Test with manual trigger** — Before enabling schedule
8. **Chain related flows** — Keep each flow focused on one thing
