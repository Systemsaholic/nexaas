# Nexaas — Development & Operations

You are working on the Nexaas platform codebase. This guide helps you deploy, debug, fix, and build features.

## Quick Reference

| Task | Command |
|------|---------|
| Deploy fresh | `./deploy.sh` |
| Deploy demo | `./deploy.sh demo` |
| Health check | `bash scripts/health-check.sh --docker` |
| View logs | `docker compose logs -f engine` |
| Restart | `docker compose restart engine` |
| Run tests | `cd engine && pytest` |
| Lint dashboard | `cd dashboard && npm run lint` |
| Validate framework | `bash framework/scripts/validate-framework.sh` |

---

## Project Structure

```
engine/                 # Python FastAPI backend (port 8400)
├── api/                # REST endpoints
├── orchestrator/       # Event engine, workers, job queue
├── db/                 # SQLite schema, migrations
└── readers/            # YAML parsers

dashboard/              # Next.js 16 frontend (port 3000)
├── app/                # App router pages
└── lib/stores/         # Zustand state

framework/              # Git-tracked defaults (ships with platform)
├── agents/
├── skills/
├── playbooks/
└── mcp-servers/

workspace/              # User config (gitignored, per-deployment)
templates/              # Workspace templates for deploy.sh
```

---

## Deployment

### Fresh Workspace

```bash
./deploy.sh
# Creates workspace/ from templates/fresh/
# Starts engine + dashboard containers
# Generates .env with API_KEY and JWT_SECRET
```

### Demo Mode

```bash
./deploy.sh demo
# Uses examples/demo/ with sample agents, registries, data
```

### Local Development

```bash
# Terminal 1: Engine
cd engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py

# Terminal 2: Dashboard
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

### Environment Variables

**Engine** (`.env`):
```bash
API_KEY=required          # Bearer token for API
JWT_SECRET=required       # JWT signing secret
DATABASE_PATH=data/nexaas.db
ENGINE_TICK_SECONDS=30
WORKER_POOL_SIZE=3
```

**Dashboard** (`dashboard/.env.local`):
```bash
NEXT_PUBLIC_DEFAULT_GATEWAY_URL=http://localhost:8400
ENGINE_INTERNAL_URL=http://engine:8400    # Docker internal
DEFAULT_GATEWAY_KEY=your-api-key
COOKIE_SECURE=false                        # Set true for HTTPS
```

---

## Debugging

### Check Health

```bash
curl http://localhost:8400/api/health
bash scripts/health-check.sh --docker
```

### View Logs

```bash
docker compose logs -f              # All
docker compose logs -f engine       # Engine only
docker compose logs -f dashboard    # Dashboard only
```

### Database Queries

```bash
docker compose exec engine sqlite3 /data/nexaas.db

# Active events
SELECT id, type, status, next_eval_at FROM events WHERE status = 'active';

# Recent runs
SELECT event_id, result, error, duration_ms FROM event_runs ORDER BY started_at DESC LIMIT 10;

# Pending jobs
SELECT * FROM job_queue WHERE status = 'pending';

# Token usage
SELECT model, SUM(input_tokens) as input, SUM(output_tokens) as output FROM token_usage GROUP BY model;
```

### Common Issues

**Engine won't start:**
1. Check `.env` exists with `API_KEY` and `JWT_SECRET`
2. Check logs: `docker compose logs engine`
3. Check permissions: `ls -la data/`

**Jobs not running:**
1. Check worker status: `curl -H "Authorization: Bearer $API_KEY" localhost:8400/api/queue`
2. Check if events are paused (max retries exceeded)
3. Check Claude auth: `docker compose exec engine claude auth status`

**Dashboard can't connect:**
1. Verify `NEXT_PUBLIC_DEFAULT_GATEWAY_URL` is correct
2. For Docker: `ENGINE_INTERNAL_URL=http://engine:8400`
3. For HTTPS: `COOKIE_SECURE=true`

**Memory items not syncing:**
```bash
docker compose restart engine   # Syncs on startup
```

**Resume paused event:**
```bash
sqlite3 data/nexaas.db "UPDATE events SET status='active', consecutive_fails=0 WHERE id='EVENT_ID'"
```

---

## Bug Fixes

### Workflow

1. Reproduce the issue
2. Check logs for stack traces
3. Find the relevant code:
   - API issue → `engine/api/`
   - Job execution → `engine/orchestrator/workers.py`
   - Event scheduling → `engine/orchestrator/event_engine.py`
   - Dashboard → `dashboard/app/` or `dashboard/lib/`
4. Write a fix
5. Test locally
6. Run linting: `cd dashboard && npm run lint`

### Key Files by Area

| Area | Files |
|------|-------|
| Event scheduling | `engine/orchestrator/event_engine.py` |
| Job execution | `engine/orchestrator/workers.py` |
| Job queue | `engine/orchestrator/job_queue.py` |
| Claude sessions | `engine/orchestrator/session_manager.py` |
| REST API | `engine/api/*.py` |
| YAML parsing | `engine/readers/*.py` |
| Database | `engine/db/schema.sql`, `engine/db/database.py` |
| Dashboard state | `dashboard/lib/stores/*.ts` |
| Dashboard pages | `dashboard/app/**/*.tsx` |

---

## Feature Development

### Adding an API Endpoint

1. Create or edit file in `engine/api/`
2. Add router to `engine/api/__init__.py`
3. Test: `curl -H "Authorization: Bearer $API_KEY" localhost:8400/api/your-endpoint`

### Adding a Dashboard Page

1. Create `dashboard/app/your-page/page.tsx`
2. Add to navigation if needed
3. Use stores from `dashboard/lib/stores/`

### Adding a Framework Agent

1. Create `framework/agents/{name}/config.yaml`
2. Add `framework/agents/{name}/prompt.md`
3. Validate: `bash framework/scripts/validate-framework.sh`

### Adding a Framework Skill

1. Create `framework/skills/{name}.md`
2. Format: Heading = name, first line = description, rest = instructions
3. Validate: `bash framework/scripts/validate-framework.sh`

### Adding an MCP Server to Catalog

1. Add config to `framework/mcp-servers/{name}.json`
2. Document in `framework/playbooks/07-mcp-integration.md`

### Adding a New Action Type

1. Create executor function in `engine/orchestrator/workers.py`
2. Add to `EXECUTORS` dict
3. Update event schema if needed

---

## CI/CD

### Pre-commit Checks

```bash
# Dashboard
cd dashboard && npm run lint && npm run build

# Engine
cd engine && python -m pytest

# Framework
bash framework/scripts/validate-framework.sh
```

### Framework Validation Rules

When modifying `framework/`:
- No real company names, domains, API keys
- Use placeholders: `{{COMPANY_NAME}}`, `{{AGENT_NAME}}`, `{{DOMAIN}}`
- Run validation before committing

### Contribution from Customer Deployments

```bash
# On customer server — export sanitized patch
bash scripts/contribute.sh --export

# On dev server — apply and push
git apply exports/*.patch
git commit -m "feat: description"
git push
```

Sanitization blocks: API keys, customer names, domains, webhook URLs.

---

## Architecture Reference

### Event Flow

```
Event Engine (tick every 30s)
    │
    ├─ SELECT * FROM events WHERE status='active' AND next_eval_at <= now
    │
    ├─ Evaluate condition: cron | interval | once | webhook
    │
    ├─ Enqueue job → job_queue table
    │
    └─ Workers poll → Execute → Record in event_runs
```

### Action Types

| Type | Executor | Config |
|------|----------|--------|
| `claude_chat` | `_execute_claude_chat` | `{prompt, agent, messages}` |
| `skill` | `_execute_skill` | `{skill, agent, input}` |
| `script` | `_execute_script` | `{command, cwd, timeout}` |
| `webhook` | `_execute_webhook` | `{url, method, headers, body}` |
| `flow` | `_execute_flow` | `{flow_id, steps[], trigger_payload}` |

### Database Tables

| Table | Purpose |
|-------|---------|
| `events` | Scheduled events (conditions, actions, status) |
| `event_runs` | Execution history |
| `job_queue` | Pending/running jobs |
| `chat_sessions` | Claude Code sessions |
| `chat_messages` | Chat history |
| `token_usage` | API usage tracking |
| `users` | User accounts |
| `companies` | Multi-tenant companies |

### Merge Behavior

```
framework/{agents,skills,mcp-servers}/    ← Defaults (git-tracked)
workspace/{agents,skills,registries}/     ← Overrides (gitignored)

Rule: Workspace files with same name override framework files
```

---

## Playbooks

Detailed guides in `framework/playbooks/`:

| # | Playbook | Use When |
|---|----------|----------|
| 01 | `initial-setup.md` | First deployment |
| 02 | `add-agent.md` | Creating agents |
| 03 | `add-skill.md` | Creating skills |
| 04 | `add-registry.md` | Creating data stores |
| 05 | `memory-system.md` | Scheduling tasks |
| 06 | `custom-dashboard.md` | Dashboard layout |
| 07 | `mcp-integration.md` | External tools |
| 08 | `contribute-upstream.md` | Exporting changes |
| 09 | `flows.md` | Multi-step automations |
