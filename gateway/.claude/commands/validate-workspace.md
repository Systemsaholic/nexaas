# Validate Workspace

You are validating the integrity of the current workspace. Run all checks and report results clearly.

## Validation Checks

Run each check and track pass/fail/warn status. Present results at the end.

### 1. workspace.yaml Schema

Read `workspace.yaml` and validate:
- [ ] File exists and is valid YAML
- [ ] Has required top-level fields: `name`, `description`, `perspectives`
- [ ] Each perspective has: `name`, `pages` (list)
- [ ] Each page has: `id`, `name`, `components` (list)
- [ ] Each component has: `type`, `config`
- [ ] Component types are valid (one of: `stat-cards`, `agent-tree`, `agent-chat`, `event-timeline`, `queue-status`, `registry-table`, `data-table`, `email-preview`, `email-list`, `social-media-preview`, `pipeline-board`, `draft-list`, `chart`, `calendar`, `markdown-viewer`)
- [ ] No duplicate page IDs across the entire workspace
- [ ] Each perspective with a `default_page` references a valid page ID within that perspective

### 2. Agent References

For every `agent-chat` component in `workspace.yaml`:
- [ ] The referenced agent name has a corresponding directory in `agents/`
- [ ] That directory contains `config.yaml`
- [ ] That directory contains `prompt.md`

For every agent directory in `agents/`:
- [ ] `config.yaml` is valid YAML
- [ ] `config.yaml` has required fields: `name`, `role`, `capabilities`
- [ ] If `parent` is specified, the parent agent directory exists
- [ ] No circular parent references
- [ ] `prompt.md` exists and is non-empty

### 3. Registry References

For every `registry-table` component in `workspace.yaml`:
- [ ] The referenced registry has a corresponding file in `registries/`
- [ ] The registry YAML is valid and defines a schema

For every registry file in `registries/`:
- [ ] Valid YAML format
- [ ] Has required fields: `name`, `fields`
- [ ] Each field has: `name`, `type`

### 4. MCP Server Configuration

Read `.mcp.json`:
- [ ] File exists and is valid JSON
- [ ] Has `mcpServers` key
- [ ] Each server has either `command` (stdio) or `url` (sse)
- [ ] Stdio servers have `command` as a string and `args` as an array
- [ ] SSE servers have valid URL format
- [ ] No empty environment variable values (possible missing secrets)

### 5. Database Integrity

Check `data/mission_control.db`:
- [ ] File exists
- [ ] SQLite can open it without errors
- [ ] Required tables exist: `events`, `jobs`, `agent_logs`
- [ ] Table schemas match expected columns
- [ ] No orphaned jobs (jobs referencing non-existent events)
- [ ] No jobs stuck in `running` status for more than 1 hour

```sql
SELECT COUNT(*) FROM jobs WHERE status = 'running' AND started_at < datetime('now', '-1 hour');
```

### 6. Event Engine

Query events table:
- [ ] All enabled cron events have valid cron expressions
- [ ] All enabled interval events have positive integer conditions
- [ ] All one-time events reference future datetimes (or are disabled)
- [ ] Action configs are valid JSON
- [ ] `claude_chat` actions have a `prompt` field
- [ ] `script` actions have a `command` field
- [ ] `webhook` actions have a `url` field

### 7. Component Data Sources

For components that reference data sources:
- [ ] `stat-cards` source paths reference valid data endpoints
- [ ] `chart` data sources are queryable
- [ ] `data-table` sources exist
- [ ] `markdown-viewer` source files exist

### 8. CLAUDE.md

- [ ] File exists in workspace root
- [ ] Contains workspace name
- [ ] Documents the workspace structure

## Output Format

Present results as a validation report:

```
=== Workspace Validation: {Workspace Name} ===

workspace.yaml ........... PASS (N checks)
Agent references ......... PASS (N agents validated)
Registry references ...... WARN (1 issue)
  - registries/orders.yaml: missing 'type' on field 'notes'
MCP servers .............. PASS (N servers)
Database integrity ....... PASS
Event engine ............. FAIL (2 issues)
  - Event 'daily-report': invalid cron expression '0 25 * * *'
  - Event 'one-time-cleanup': scheduled in the past (2024-01-01)
Component references ..... PASS
CLAUDE.md ................ PASS

Result: 7/8 passed, 1 warning, 1 failure
```

For each failure, suggest the corrective action (which file to edit, which command to run).

If everything passes, congratulate the user and confirm the workspace is healthy.
