# Workspace Status

Show current workspace configuration and health.

## Step 0: Detect Deployment Type

```bash
if docker compose ps 2>/dev/null | grep -q "engine"; then
  DEPLOY_TYPE="docker"
elif systemctl is-active nexaas-engine 2>/dev/null; then
  DEPLOY_TYPE="systemd"
else
  DEPLOY_TYPE="local"
fi
```

## Step 1: Check Services

```bash
curl -s http://localhost:8400/api/health | jq .
```

Report: Engine healthy/unhealthy, deployment type: {DEPLOY_TYPE}

## Step 2: List Agents

```bash
ls -la workspace/agents/
```

For each agent, read `config.yaml` and summarize:
- Name
- Role
- Parent (if any)
- Sub-agents (if any)

Present as tree:
```
Agents:
├── director (Agency Director)
│   ├── content-writer (Content Creator)
│   └── email-manager (Email Operations)
└── ops-monitor (System Monitor)
```

## Step 3: List Registries

```bash
ls workspace/registries/*.yaml 2>/dev/null
```

For each registry, count entries:
```
Registries:
- clients: 5 entries
- templates: 12 entries
- drafts: 3 entries
```

## Step 4: Check MCP Servers

Read `workspace/.mcp.json` and list enabled servers:
```
MCP Servers:
- filesystem (enabled)
- fetch (enabled)
- github (enabled, requires GITHUB_PERSONAL_ACCESS_TOKEN)
```

## Step 5: Check Scheduled Tasks

Read `workspace/memory/checks.yaml` and `workspace/memory/followups.yaml`:

```
Scheduled Tasks:
Recurring:
- daily-inbox-check (every 24h, agent: email-manager)
- weekly-report (every 168h, agent: director)

One-time:
- q1-review (due: 2025-04-01, agent: director)
```

## Step 6: Recent Activity

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "localhost:8400/api/events?limit=5" | jq '.[] | {id, type, status, last_run_at}'
```

## Step 7: Summary

```
========================================
  Workspace Status
========================================

Engine:      healthy
Agents:      {count} ({count} root, {count} sub)
Registries:  {count} ({total entries} total entries)
MCP Servers: {count} enabled
Scheduled:   {count} recurring, {count} one-time

Recent runs:
- {event}: {result} ({time ago})
- {event}: {result} ({time ago})

Dashboard: http://localhost:3000
========================================
```
