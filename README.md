# AI Mission Control

A platform for orchestrating and monitoring AI agent workspaces.

## Components

- **Engine** — Python FastAPI service: event engine, job queue, chat proxy, ops monitor, auth
- **Dashboard** — Next.js app: workspace visualization, agent management, real-time monitoring

## Quick Start (Docker)

```bash
./deploy.sh
```

This builds both services, starts them, and walks you through setup. Once running:

- **Dashboard**: http://localhost:3000 — register your account to get started
- **Engine API**: http://localhost:8400

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

## Production Deployment

For systemd-based Linux servers:

```bash
cd engine && bash install.sh
```

Or use the Claude Code command: `/deploy-engine`

## Health Check

```bash
# Local
bash scripts/health-check.sh

# Docker
bash scripts/health-check.sh --docker
```

## Architecture

```
dashboard/          Next.js 16 frontend
  app/              App router pages (workspace, login, register)
  lib/stores/       Zustand state management
  components/       Shared UI components

engine/             FastAPI backend
  api/              REST endpoints (workspace, agents, events, auth, ops)
  orchestrator/     Event engine, worker pool, ops monitor
  db/               SQLite schema + migrations
```
