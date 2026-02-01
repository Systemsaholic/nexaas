# Workspace Status

You are displaying a comprehensive summary of the current workspace. Gather information from all sources and present it clearly.

## Gather Data

Perform the following checks in order:

### 1. Workspace Identity
Read `workspace.yaml` and extract:
- Workspace name
- Description
- Use case

### 2. Agent Inventory
List all directories in `agents/`. For each, read `config.yaml` and extract:
- Agent name and role
- Parent agent (to build hierarchy)
- Capabilities

Display as an indented tree showing parent-child relationships:
```
Agents (N total):
  manager (Operations Manager)
    email-handler (Email Processing) [email, read, write]
    scheduler (Task Scheduling) [schedule, delegate]
  support-bot (Customer Support) [chat, read]
```

### 3. Registries
List all files in `registries/`. For each `.yaml` file, show the registry name and field count.

```
Registries (N total):
  contacts - 8 fields
  products - 12 fields
  orders - 10 fields
```

### 4. MCP Server Connections
Read `.mcp.json` and list all configured servers:
```
MCP Servers (N configured):
  gmail (stdio) - npx @anthropic/mcp-gmail
  hubspot (stdio) - npx @anthropic/mcp-hubspot
  custom-api (sse) - https://api.example.com/mcp
```

### 5. Perspectives and Pages
Read `workspace.yaml` and summarize:
```
Perspectives (N total):
  Admin (3 pages) [default: overview]
  Marketing (2 pages) [default: campaigns]
```

### 6. Events
Query the SQLite database at `data/mission_control.db`:
```sql
SELECT type, COUNT(*) as count, SUM(enabled) as active FROM events GROUP BY type;
```

Display:
```
Events:
  Cron: 5 (4 active)
  Interval: 2 (2 active)
  One-time: 1 (0 active)
```

### 7. Job Queue Status
Query the database:
```sql
SELECT status, COUNT(*) as count FROM jobs GROUP BY status;
```

Display:
```
Job Queue:
  Pending: 3
  Running: 1
  Completed: 47
  Failed: 2
```

### 8. Gateway Health
Try to reach the gateway health endpoint:
```bash
curl -s --connect-timeout 3 http://localhost:8080/health
```

Display:
- **Running** with version and uptime if healthy
- **Not reachable** if the request fails (suggest `/deploy-gateway`)

## Output Format

Present everything in a clean, structured format:

```
=== AI Mission Control: {Workspace Name} ===
{description}

Agents:       {N} total
Registries:   {N} total
MCP Servers:  {N} configured
Perspectives: {N} ({total pages} pages)
Events:       {N} ({active} active)
Job Queue:    {pending} pending, {running} running
Gateway:      {status}

{detailed sections as above}
```

If any section encounters errors (missing files, database not initialized, etc.), note the issue and suggest the relevant slash command to fix it.
