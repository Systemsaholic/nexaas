# Nexaas

A platform for orchestrating and monitoring AI agent workspaces with built-in authentication, deployment tooling, and self-healing operations.

## Components

- **Engine** — Python FastAPI backend: event engine, job queue, chat proxy, ops monitor, auth (bcrypt + JWT)
- **Dashboard** — Next.js frontend: workspace visualization, agent management, real-time monitoring, login/register

## Deployment Options

Nexaas supports two deployment models:

| Model | Use Case | Clients | Infrastructure |
|-------|----------|---------|----------------|
| **VPS** | Dedicated single-tenant deployment | 1 | Dedicated server |
| **Docker** | Multi-tenant shared infrastructure | Multiple | Shared VPS or cluster |

---

## VPS Deployment (Single-Tenant)

Best for dedicated client deployments where each client gets their own server.

### Recommended Specs

| Tier | vCPU | RAM | Storage | Clients | Use Case |
|------|------|-----|---------|---------|----------|
| **Starter** | 2 | 4 GB | 50 GB SSD | 1 | Small teams, <5 agents |
| **Standard** | 4 | 8 GB | 100 GB SSD | 1 | Medium teams, 5-15 agents |
| **Performance** | 8 | 16 GB | 200 GB NVMe | 1 | Large teams, 15+ agents, heavy automation |

### Installation

```bash
# Clone the repository
git clone https://github.com/Systemsaholic/nexaas.git
cd nexaas

# Run the VPS installer
cd engine && bash install.sh
```

The installer will:
1. Install Python 3.11+ and create a virtual environment
2. Install Node.js 20+ and npm
3. Install Claude Code CLI
4. Initialize the SQLite database
5. Build the Next.js dashboard
6. Create systemd services for engine and dashboard
7. Configure automatic restarts and logging

### Post-Installation

```bash
# Check service status
sudo systemctl status nexaas-engine
sudo systemctl status nexaas-dashboard

# View logs
journalctl -u nexaas-engine -f
journalctl -u nexaas-dashboard -f
```

Access the dashboard at `http://your-server-ip:3000/register`.

### HTTP-Only Deployments (Tailscale/VPN)

For internal networks without HTTPS, add to your systemd environment:

```bash
Environment=COOKIE_SECURE=false
```

---

## Docker Deployment (Multi-Tenant)

Best for hosting multiple clients on shared infrastructure. Each client runs as an isolated container stack.

### Recommended Specs (Host Server)

| Tier | vCPU | RAM | Storage | Clients | Use Case |
|------|------|-----|---------|---------|----------|
| **Micro** | 2 | 4 GB | 80 GB SSD | 2-3 | Freelancer, small agency |
| **Mini** | 4 | 8 GB | 150 GB SSD | 5-8 | Growing agency |
| **Standard** | 8 | 16 GB | 300 GB NVMe | 10-15 | Established agency |
| **Scale** | 16 | 32 GB | 500 GB NVMe | 20-30 | Large MSP |

**Per-client resource allocation:**
- ~0.5 vCPU per client (burstable)
- ~512 MB - 1 GB RAM per client
- ~5-10 GB storage per client

### Quick Start

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

### Multi-Client Setup

For multiple clients on the same host, use separate compose projects with unique ports:

```bash
# Client A (ports 3001/8401)
COMPOSE_PROJECT_NAME=client-a DASHBOARD_PORT=3001 ENGINE_PORT=8401 ./deploy.sh

# Client B (ports 3002/8402)
COMPOSE_PROJECT_NAME=client-b DASHBOARD_PORT=3002 ENGINE_PORT=8402 ./deploy.sh
```

Or use a reverse proxy (Traefik, Caddy, nginx) for subdomain routing.

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

---

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

## Development Setup

For local development without Docker:

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

## Production Checklist

Before going live:

- [ ] Set strong `API_KEY` and `JWT_SECRET` values
- [ ] Configure HTTPS via reverse proxy (Caddy, nginx, Traefik)
- [ ] Set `COOKIE_SECURE=true` (default in production with HTTPS)
- [ ] Enable firewall (allow only 80/443, SSH)
- [ ] Set up automated backups for `data/nexaas.db`
- [ ] Configure log rotation for systemd journals
- [ ] Set up monitoring/alerting (optional)

For VPS deployment details, see [VPS Deployment](#vps-deployment-single-tenant) above.

## Health Check

```bash
# Local
bash scripts/health-check.sh

# Docker
bash scripts/health-check.sh --docker
```

Checks engine health, database access, container status (Docker mode), and dashboard reachability. Exit code equals the number of failed checks.

## Documentation

| Guide | Description |
|-------|-------------|
| [Token Optimization](docs/token-optimization.md) | Reduce context usage with tiered prompt loading |

## Examples

| Example | Description |
|---------|-------------|
| `examples/demo/` | BrightWave Digital agency demo |
| `examples/optimized-agent/` | Token-efficient agent with reference files |

## Architecture

```
docs/                   Documentation
  token-optimization.md Guide to reducing context window usage

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

examples/optimized-agent/ Token-efficient agent example
  agents/content-publisher/
    prompt.md           Core workflow (~100 lines)
    reference/          Detailed procedures (on-demand)

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
