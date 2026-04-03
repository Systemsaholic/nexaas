# Nexaas

The proprietary backbone of **Nexmatic** — an AI business automation platform for SMB clients. Nexaas orchestrates durable, context-aware AI workflows across multiple isolated client workspaces using Trigger.dev and Claude Code.

## Components

- **Trigger.dev** (self-hosted) — Task scheduling, queuing, retries, and observability
- **Claude Code CLI** — Headless AI execution inside Trigger tasks (`trigger/lib/claude.ts`)
- **Orchestrator** — Workspace session bootstrap, context continuity, skill feedback
- **Dashboard** — Next.js frontend: workspace visualization, agent management, real-time monitoring
- **Skills** — Reusable AI capabilities shared across workspaces (the "neuro-network")

## Architecture

```
Nexmatic (product)
└── Nexaas (this repo — the backbone)
    ├── trigger/            Trigger.dev task definitions + battle-tested libs
    │   ├── tasks/          run-agent, run-skill, cron-tasks
    │   └── lib/            claude.ts, shell.ts, telegram.ts, yaml-checks.ts
    ├── orchestrator/       Workspace session bootstrap + context
    │   └── bootstrap/      createWorkspaceSession() — start here
    ├── skills/             Reusable AI capabilities (skill registry)
    │   └── _registry.yaml  Master skill index
    ├── agents/             Agent definitions (config.yaml + prompt.md)
    ├── mcp/                MCP server configs and registry
    │   ├── _registry.yaml  All servers, ports, capabilities
    │   └── configs/        16 MCP server YAML configs
    ├── workspaces/         Client workspace manifests
    ├── platform/           Docker Compose stack (Trigger.dev + Postgres + Redis + MinIO)
    ├── database/           Unified Postgres schema + migrations
    ├── templates/          Skill, agent, workspace templates
    ├── dashboard/          Next.js UI (Nexmatic-branded)
    ├── engine/             Legacy Python FastAPI (being retired)
    └── scripts/            Deployment, provisioning, health checks
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker + Docker Compose (for platform stack)
- Claude Code CLI installed

### Development Setup

```bash
# Clone the repository
git clone https://github.com/Systemsaholic/nexaas.git
cd nexaas

# Install Trigger.dev + orchestrator dependencies
npm install

# Start the platform stack (Trigger.dev, Postgres, Redis, MinIO)
cd platform && docker compose up -d

# Start the Trigger.dev worker (development mode)
npm run dev
```

### Production Deployment (VPS)

```bash
# 1. Start the platform stack
cd platform && docker compose up -d

# 2. Start the worker via systemd
sudo cp scripts/trigger-dev-worker.service /etc/systemd/system/
sudo systemctl enable nexaas-worker && sudo systemctl start nexaas-worker

# 3. Provision a client workspace
./scripts/provision-workspace.sh [workspace-id] [vps-ip]
```

---

## Workspace Manifests

Each client workspace is declared in `workspaces/[id].workspace.json`:

```json
{
  "id": "client-id",
  "name": "Client Name",
  "workspaceRoot": "/opt/workspaces/client-id",
  "skills": ["msp/email-triage", "finance/receipt-scanner"],
  "agents": ["ops-monitor"],
  "mcp": {
    "filesystem": "http://localhost:3100",
    "email": "http://localhost:3101"
  },
  "capabilities": { "playwright": true, "docker": true, "bash": true }
}
```

Every Trigger task starts with `createWorkspaceSession(workspaceId)` which loads the manifest, resolves MCP servers, and returns the full session context.

---

## Skills

Skills are reusable AI capabilities that run across workspaces. Each skill lives in `skills/[category]/[skill-name]/`:

- `skill.yaml` — manifest (id, version, resources, inputs, outputs)
- `prompt.md` — Claude instructions
- `task.ts` — Trigger.dev task wrapper (optional)
- `tests/` — test cases

The master skill index is `skills/_registry.yaml`. See `templates/skill.yaml` and `templates/prompt.md` for authoring templates.

---

## MCP Servers

All 16 MCP servers are documented in `mcp/_registry.yaml` with ports, capabilities, and required environment variables. Server configs live in `mcp/configs/`.

Available servers: filesystem, email, m365, github, postgres, playwright, brave-search, slack, sequential-thinking, memory, fetch, nextcloud, telegram, vaultwarden, docuseal, groundhogg.

---

## Operational Stability

The Trigger.dev worker includes battle-tested stability features from production deployments:

| Feature | Implementation |
|---------|---------------|
| **OOM Prevention** | systemd `MemoryMax=6G` / `MemoryHigh=5G` |
| **Concurrency Cap** | `--max-concurrent-runs 5` (~1.5GB per Claude CLI) |
| **Process Cleanup** | `detached: true` + negative PID kill (entire tree) |
| **MCP Context Overflow** | `--strict-mcp-config` per-task whitelisting |
| **Self-Healing** | Global `onFailure` handler with Claude diagnosis |
| **Queue Separation** | `claude-agents(3)`, `yaml-checks(2)`, `data-sync(2)`, `cron-tasks(2)` |
| **Restart Safety** | `StartLimitBurst=5`, `RestartSec=30` |

---

## Dashboard

The Next.js dashboard at `dashboard/` provides workspace visualization, agent management, and real-time monitoring.

### Development

```bash
cd dashboard
cp .env.local.example .env.local
npm install
npm run dev
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_DEFAULT_GATEWAY_URL` | `http://localhost:8400` | Engine URL (client-side) |
| `ENGINE_INTERNAL_URL` | _(unset)_ | Engine URL for server-side (Docker: `http://engine:8400`) |
| `DEFAULT_GATEWAY_KEY` | _(unset)_ | API key for engine (server-side) |
| `COOKIE_SECURE` | _(auto)_ | Set `false` for HTTP-only (e.g., Tailscale VPN) |

---

## Legacy Engine

The Python FastAPI engine at `engine/` is being replaced by Trigger.dev. It remains functional during the transition.

### Running the Legacy Engine

```bash
cd engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

---

## Environment Variables

Set in `.env` (never committed). See `.env.example` for all variables.

| Variable | Description |
|----------|-------------|
| `TRIGGER_SECRET_KEY` | Trigger.dev secret key |
| `TRIGGER_API_URL` | Self-hosted Trigger.dev endpoint |
| `TRIGGER_PROJECT_REF` | Trigger.dev project reference |
| `DATABASE_URL` | Shared Postgres connection string |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `NEXAAS_ROOT` | Path to nexaas repo on VPS (`/opt/nexaas`) |
| `NEXAAS_WORKSPACE` | Workspace ID for this Trigger project |
| `WORKSPACE_ROOT` | Absolute path to workspace on VPS |
| `CLAUDE_CODE_PATH` | Path to Claude Code CLI binary |
| `TELEGRAM_BRIDGE_URL` | Telegram notification bridge |

---

## Auto-Update

Smart update script that detects change types and applies minimal required actions:

| Change Type | Action |
|-------------|--------|
| Agents, skills, MCP configs, templates | Pull only (hot reload) |
| Trigger tasks/libs, orchestrator code | Pull + restart worker |
| Dashboard code (TypeScript) | Pull + rebuild + restart dashboard |
| Dependencies | Pull + install deps + rebuild + restart |

```bash
bash scripts/update.sh            # Interactive (auto-detects mode)
bash scripts/update.sh --force    # Non-interactive
bash scripts/update.sh --full     # Force full rebuild
```

---

## Contributing Improvements

When you fix bugs or improve skills on a client deployment, contribute them back:

```bash
# 1. On client server: export sanitized patch
bash scripts/contribute.sh --export

# 2. Copy to dev server
scp exports/*.patch user@dev-vps:/opt/nexaas/exports/

# 3. On dev server: apply and push
cd /opt/nexaas
git checkout -b fix/description
git apply exports/*.patch
git add -A && git commit -m "Fix: description"
git push && gh pr create

# 4. After merge: update all deployments
bash scripts/update-all.sh
```

See [Contributing Upstream](framework/playbooks/08-contribute-upstream.md) for details.

---

## Health Check

```bash
bash scripts/health-check.sh              # Local
bash scripts/health-check.sh --docker     # Docker
```

---

## Playbooks

Detailed guides in `framework/playbooks/`:

| # | Playbook | Use When |
|---|----------|----------|
| 01 | Initial Setup | First deployment |
| 02 | Add Agent | Creating agents |
| 03 | Add Skill | Creating skills |
| 04 | Add Registry | Creating data stores |
| 05 | Memory System | Scheduling tasks |
| 06 | Custom Dashboard | Dashboard layout |
| 07 | MCP Integration | External tools |
| 08 | Contributing Upstream | Exporting changes |
| 09 | Flows | Multi-step automations |

---

## New Workspace Setup

1. Copy `templates/workspace.workspace.json` to `workspaces/[client-id].workspace.json`
2. Fill in workspace root, skill subscriptions, MCP endpoints
3. Create Trigger.dev project for the workspace
4. Run `scripts/provision-workspace.sh [client-id] [vps-ip]`
5. Verify worker registered in Trigger.dev dashboard
