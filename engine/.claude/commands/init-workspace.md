# Initialize Workspace

You are bootstrapping a new AI Mission Control workspace. Walk through each step interactively, confirming with the user before proceeding.

## Step 1: Gather Business Context

Ask the user for:
- **Business name** (used as workspace identifier)
- **Business description** (1-2 sentences)
- **Primary use case** (e.g., customer support, marketing automation, operations management)

Wait for their response before continuing.

## Step 2: Create Directory Structure

Once you have the business context, create the workspace directory structure. Ask the user where they want the workspace created (suggest `~/workspaces/{business-name-slug}/`).

```
{workspace_root}/
  agents/
  registries/
  data/
  .claude/
    commands/
```

Create all directories.

## Step 3: Generate workspace.yaml

Create `{workspace_root}/workspace.yaml` with:

```yaml
name: "{business_name}"
description: "{business_description}"
use_case: "{primary_use_case}"

perspectives:
  - name: Admin
    icon: shield
    description: Full system overview and management
    default_page: overview
    pages:
      - id: overview
        name: Overview
        icon: layout-dashboard
        description: Workspace summary and health
        components:
          - type: stat-cards
            config:
              cards:
                - label: Active Agents
                  source: agents.count
                - label: Queued Jobs
                  source: jobs.pending_count
                - label: Events Today
                  source: events.today_count
          - type: agent-tree
            config:
              title: Agent Hierarchy
          - type: event-timeline
            config:
              title: Recent Activity
              limit: 20
```

## Step 4: Generate CLAUDE.md

Create `{workspace_root}/CLAUDE.md` with business context, workspace conventions, and instructions for Claude Code when working in this workspace:

```markdown
# {Business Name} - AI Mission Control Workspace

## Business Context
{business_description}

**Primary Use Case:** {primary_use_case}

## Workspace Structure
- `workspace.yaml` - Dashboard configuration (perspectives, pages, components)
- `agents/` - Agent configurations and prompts
- `registries/` - Data registry definitions
- `data/` - SQLite databases and local data files
- `.mcp.json` - MCP server connections

## Conventions
- Agent configs use YAML format in `agents/{name}/config.yaml`
- Agent prompts live in `agents/{name}/prompt.md`
- Registry schemas are defined in `registries/{name}.yaml`
- All timestamps are UTC
- Use slash commands in `.claude/commands/` for guided workflows
```

## Step 5: Copy Slash Commands

Copy the gateway's `.claude/commands/` directory contents into `{workspace_root}/.claude/commands/` so the user has all slash commands available from the workspace root.

## Step 6: Initialize SQLite Database

Create the SQLite database at `{workspace_root}/data/mission_control.db` with the core schema:

```sql
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('cron', 'interval', 'one_time')),
    condition TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('claude_chat', 'script', 'webhook')),
    action_config TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    concurrency_key TEXT,
    max_retries INTEGER DEFAULT 3,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    priority INTEGER DEFAULT 5,
    payload TEXT,
    result TEXT,
    error TEXT,
    attempts INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    concurrency_key TEXT,
    scheduled_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    action TEXT NOT NULL,
    input TEXT,
    output TEXT,
    status TEXT DEFAULT 'success',
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_jobs_concurrency ON jobs(concurrency_key);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent_name);
```

Run this SQL using `sqlite3`.

## Step 7: Optionally Deploy Gateway

Ask the user: "Would you like to deploy the gateway service now? (This requires a server with systemd.)"

- If **yes**, run the `/deploy-gateway` slash command.
- If **no**, tell them they can run `/deploy-gateway` later.

## Completion

Print a summary of what was created:
- Workspace path
- Number of directories created
- Database location
- Available slash commands
- Next recommended steps (add agents, add integrations, add pages)
