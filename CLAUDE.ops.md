# Nexaas — Operations

You are operating a deployed Nexaas instance. This guide helps you configure workspaces, troubleshoot issues, and manage the platform.

## Quick Reference

| Task | Command |
|------|---------|
| Health check | `bash scripts/health-check.sh --docker` |
| View logs | `docker compose logs -f engine` |
| Restart engine | `docker compose restart engine` |
| Restart all | `docker compose down && docker compose up -d` |
| Database shell | `docker compose exec engine sqlite3 /data/nexaas.db` |

---

## Workspace Configuration

### File Locations

```
workspace/
├── CLAUDE.md           # Agent context (edit for your team)
├── workspace.yaml      # Dashboard layout, MCP servers
├── agents/             # Agent definitions
│   └── {name}/
│       ├── config.yaml
│       └── prompt.md
├── registries/         # Data stores
│   └── {name}.yaml
├── skills/             # Task definitions
│   └── {name}.md
└── memory/
    ├── followups.yaml  # One-time tasks
    └── checks.yaml     # Recurring tasks
```

### Adding an Agent

Create `workspace/agents/{name}/config.yaml`:
```yaml
name: agent-name
role: Agent Role
description: What this agent does
capabilities:
  - chat
  - delegate
sub_agents:
  - child-agent-name
```

Create `workspace/agents/{name}/prompt.md`:
```markdown
You are the Agent Role...

Your responsibilities:
- Task 1
- Task 2
```

### Adding a Registry

Create `workspace/registries/{name}.yaml`:
```yaml
name: registry-name
description: What this stores
fields:
  - name: field_name
    type: string
  - name: status
    type: string
entries:
  - field_name: Value
    status: active
```

### Adding a Skill

Create `workspace/skills/{name}.md`:
```markdown
# Skill Name
One-line description of what this skill does.

## Steps
1. First step
2. Second step

## Output Format
- Expected output structure
```

### Scheduling Tasks

**One-time task** — `workspace/memory/followups.yaml`:
```yaml
followups:
  - id: unique-id
    description: Task description
    agent: agent-name
    due: "2025-04-01T09:00:00Z"
    action:
      prompt: "Instructions for the agent"
```

**Recurring task** — `workspace/memory/checks.yaml`:
```yaml
checks:
  - id: unique-id
    description: Check description
    agent: agent-name
    interval: 86400    # Seconds (86400 = 24h)
    action:
      prompt: "Instructions for the agent"
```

After editing memory files:
```bash
docker compose restart engine   # Syncs on startup
```

### Enabling MCP Servers

Edit `workspace/.mcp.json`:
```json
{
  "mcpServers": {},
  "enabledFrameworkServers": ["filesystem", "fetch", "memory"]
}
```

Available servers: `filesystem`, `fetch`, `memory`, `github`, `email`, `slack`, `brave-search`, `postgres`, `telegram`, `nextcloud`

Servers requiring credentials need env vars in `.env` first.

### Customizing Dashboard

Edit `workspace/workspace.yaml`:
```yaml
name: My Workspace
description: Description

mcp_servers:
  - filesystem
  - fetch

perspectives:
  - id: operations
    name: Operations
    icon: activity
    default_page: overview
    pages:
      - id: overview
        name: Overview
        layout: grid
        components:
          - type: agent-tree
            span: 6
          - type: event-timeline
            span: 6
```

Component types: `agent-tree`, `event-timeline`, `agent-chat`, `queue-status`, `registry-table`

---

## Troubleshooting

### Check Health

```bash
curl http://localhost:8400/api/health
bash scripts/health-check.sh --docker
```

### View Logs

```bash
docker compose logs -f              # All services
docker compose logs -f engine       # Engine only
docker compose logs -f dashboard    # Dashboard only
```

### Database Queries

```bash
docker compose exec engine sqlite3 /data/nexaas.db

# Active events
SELECT id, type, status, agent FROM events WHERE status = 'active';

# Recent runs (check for errors)
SELECT event_id, result, error, duration_ms
FROM event_runs ORDER BY started_at DESC LIMIT 10;

# Pending jobs
SELECT * FROM job_queue WHERE status = 'pending';

# Token usage by model
SELECT model, SUM(input_tokens), SUM(output_tokens)
FROM token_usage GROUP BY model;

# Failed events (paused after max retries)
SELECT id, consecutive_fails, last_result FROM events WHERE status = 'paused';
```

### Common Issues

**Engine won't start:**
1. Check `.env` has `API_KEY` and `JWT_SECRET`
2. Check logs: `docker compose logs engine`
3. Check data permissions: `ls -la data/`

**Jobs not executing:**
1. Check queue: `curl -H "Authorization: Bearer $API_KEY" localhost:8400/api/queue`
2. Check for paused events (max retries exceeded)
3. Check Claude auth: `docker compose exec engine claude auth status`

**Dashboard can't connect:**
1. Check `NEXT_PUBLIC_DEFAULT_GATEWAY_URL` in dashboard env
2. For Docker networking: `ENGINE_INTERNAL_URL=http://engine:8400`
3. For HTTPS: ensure `COOKIE_SECURE=true`

**Memory items not appearing as events:**
```bash
docker compose restart engine   # Memory syncs on startup
```

**Resume a paused event:**
```bash
sqlite3 data/nexaas.db "UPDATE events SET status='active', consecutive_fails=0 WHERE id='EVENT_ID'"
```

**Re-authenticate Claude Code:**
```bash
docker compose exec -it engine claude login
```

---

## API Quick Reference

All endpoints require `Authorization: Bearer $API_KEY` (except `/api/health`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/agents` | List agents |
| GET | `/api/registries` | List registries |
| GET | `/api/registries/{name}` | Get registry data |
| GET | `/api/skills` | List skills |
| GET | `/api/events` | List events |
| POST | `/api/events` | Create/update event |
| GET | `/api/queue` | Job queue status |
| GET | `/api/mcp-catalog` | Available MCP servers |

### Manual Event Trigger

```bash
curl -X POST http://localhost:8400/api/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "manual",
    "condition_type": "once",
    "condition_expr": "",
    "action_type": "claude_chat",
    "action_config": {"prompt": "Your task here", "agent": "agent-name"}
  }'
```

---

## Environment Variables

**Engine** (`.env`):
```bash
API_KEY=your-api-key
JWT_SECRET=your-jwt-secret
DATABASE_PATH=data/nexaas.db
ENGINE_TICK_SECONDS=30
WORKER_POOL_SIZE=3
```

**Dashboard** (`dashboard/.env.local`):
```bash
NEXT_PUBLIC_DEFAULT_GATEWAY_URL=http://localhost:8400
ENGINE_INTERNAL_URL=http://engine:8400
DEFAULT_GATEWAY_KEY=your-api-key
COOKIE_SECURE=false    # true for HTTPS
```

---

## Playbooks

Detailed guides in `framework/playbooks/`:

| Playbook | Use When |
|----------|----------|
| `02-add-agent.md` | Creating agents |
| `03-add-skill.md` | Creating skills |
| `04-add-registry.md` | Creating data stores |
| `05-memory-system.md` | Scheduling tasks |
| `06-custom-dashboard.md` | Dashboard layout |
| `07-mcp-integration.md` | External tools |

---

## Contributing Changes Upstream

If you've made improvements that should go back to the main codebase:

```bash
bash scripts/contribute.sh --export
```

This creates a sanitized patch in `exports/` (removes API keys, customer names, domains). Send the patch to the dev team.
