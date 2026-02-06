# Nexaas

A platform for orchestrating and monitoring AI agent workspaces with built-in authentication, deployment tooling, and self-healing operations.

## Components

- **Engine** — Python FastAPI backend: event engine, job queue, chat proxy, ops monitor, auth (bcrypt + JWT)
- **Dashboard** — Next.js frontend: workspace visualization, agent management, real-time monitoring, login/register

## Quick Start (Docker)

```bash
# Fresh workspace (default) — blank slate, ready to customize
./deploy.sh

# Demo mode — pre-loaded BrightWave Digital agency data
./deploy.sh demo
```

This will:
1. Check prerequisites (Docker, Docker Compose)
2. Generate a `.env` file with random API key and JWT secret
3. Copy the selected template into `workspace/` (fresh or demo)
4. Build and start both services
5. Wait for the engine to become healthy
6. Optionally authenticate Claude Code (and seed demo data in demo mode)
7. Run health checks and print a summary

Once running:

- **Dashboard**: http://localhost:3000/register — create your first account
- **Engine API**: http://localhost:8400

The first user to register creates the company and becomes admin. Subsequent registrations join as members.

### Switching Modes

To switch between fresh and demo modes, remove the workspace and redeploy:

```bash
docker compose down -v
rm -rf workspace/
./deploy.sh demo   # or ./deploy.sh for fresh
```

### Customizing Your Workspace

Edit files in `workspace/` to configure your deployment:

- `workspace/workspace.yaml` — perspectives, pages, and dashboard layout
- `workspace/agents/` — agent definitions
- `workspace/registries/` — data registries

The `workspace/` directory is gitignored so your local configuration stays private.

## Framework

The `framework/` directory contains workspace-agnostic defaults that ship with Nexaas:

- **`agents/`** — default agents (e.g., `ops-monitor`) visible in every workspace
- **`skills/`** — default skills (e.g., `health-check`) available to all agents
- **`playbooks/`** — step-by-step guides for common tasks (adding agents, skills, registries, etc.)
- **`templates/`** — skeleton files to copy into your workspace (agent configs, skills, registries, memory)
- **`packages/`** — documentation for each Nexaas subsystem
- **`GLOSSARY.md`** — standardized terminology

### Framework / Workspace Merge

The engine discovers agents and skills from both `framework/` and `workspace/`. When both define an item with the same name, **the workspace version wins**. This lets you override any framework default by creating a matching file in your workspace.

### Getting Started

See the playbooks in `framework/playbooks/`:

1. [Initial Setup](framework/playbooks/01-initial-setup.md)
2. [Add an Agent](framework/playbooks/02-add-agent.md)
3. [Add a Skill](framework/playbooks/03-add-skill.md)
4. [Add a Registry](framework/playbooks/04-add-registry.md)
5. [Memory System](framework/playbooks/05-memory-system.md)
6. [Custom Dashboard](framework/playbooks/06-custom-dashboard.md)
7. [MCP Integration](framework/playbooks/07-mcp-integration.md)

To customize, copy a template into your workspace:

```bash
cp framework/templates/agent-config.yaml workspace/agents/my-agent/config.yaml
```

## Manual Setup

### Engine

```bash
cd engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

### Dashboard

```bash
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

## Authentication

The engine provides JWT-based auth at `/api/auth`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/register` | POST | Register a new user (first user becomes admin) |
| `/api/auth/login` | POST | Log in, returns JWT |
| `/api/auth/me` | GET | Current user info (requires Bearer token) |

The dashboard proxies auth through `/api/auth/*`, storing the JWT in an httpOnly cookie. A Next.js middleware redirects unauthenticated users to `/login`.

## Environment Variables

### Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `API_KEY` | _(required)_ | Bearer token for API access |
| `JWT_SECRET` | `change-me-in-production` | Secret for signing JWTs |
| `DATABASE_PATH` | `data/nexaas.db` | SQLite database location |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8400` | Listen port |
| `WORKSPACE_ROOT` | `.` | Root directory for workspaces |

### Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_DEFAULT_GATEWAY_URL` | `http://localhost:8400` | Engine URL (client-side). Alias: `NEXT_PUBLIC_GATEWAY_URL` |
| `ENGINE_INTERNAL_URL` | _(unset)_ | Engine URL for server-side routes (used in Docker: `http://engine:8400`) |
| `DEFAULT_GATEWAY_KEY` | _(unset)_ | API key for engine (server-side only). Alias: `GATEWAY_KEY` |
| `COOKIE_SECURE` | _(auto)_ | Set to `false` for HTTP-only deployments (e.g., Tailscale VPN). Defaults to `true` in production |

## Production Deployment

For systemd-based Linux servers:

```bash
cd engine && bash install.sh
```

This installs Python deps, Node.js, Claude Code CLI, initializes the database, and sets up a systemd service.

Or use the Claude Code command: `/deploy-engine`

## Health Check

```bash
# Local
bash scripts/health-check.sh

# Docker
bash scripts/health-check.sh --docker
```

Checks engine health, database access, container status (Docker mode), and dashboard reachability. Exit code equals the number of failed checks.

## Architecture

```
framework/              Workspace-agnostic defaults (tracked in git)
  agents/               Default agents (ops-monitor)
  skills/               Default skills (health-check)
  playbooks/            Step-by-step guides
  templates/            Skeleton files to copy into workspace
  packages/             Subsystem documentation
  scripts/              Validation tooling

examples/demo/          BrightWave Digital demo data
  workspace.yaml        Demo workspace config
  agents/               Demo agent definitions
  registries/           Demo data registries
  memory/               Empty followups and checks
  seed-demo.py          Database seeder for demo mode

templates/fresh/        Blank workspace template
  workspace.yaml        Minimal workspace config
  agents/               Empty (add your agents here)
  registries/           Empty (add your registries here)
  memory/               Empty followups and checks
  CLAUDE.md             Minimal workspace context

workspace/              Active workspace (gitignored, created by deploy.sh)

dashboard/              Next.js 16 frontend
  app/                  App router pages
    login/              Login page
    register/           Registration page
    workspace/[id]/     Workspace views
    api/auth/           Auth proxy (sets httpOnly cookie)
    api/engine/         Engine API proxy
  lib/stores/           Zustand stores (workspace, auth, chat, ops)
  components/           Shared UI components
  middleware.ts         Auth gate (redirects to /login)

engine/                 FastAPI backend
  api/                  REST endpoints (workspace, agents, events, auth, ops, chat)
  orchestrator/         Event engine, worker pool, session manager, ops monitor
  db/                   SQLite schema, migrations, database helpers
  config.py             Environment-driven configuration

scripts/
  health-check.sh       System health verification

deploy.sh               One-command Docker deployment (accepts demo|fresh)
docker-compose.yml      Engine + Dashboard services
```
