# AI Mission Control

A framework for visualizing and managing AI agent workspaces.

## Components

- **Dashboard** — Next.js app for workspace visualization and interaction
- **Gateway** — Python FastAPI service exposing workspace state, event engine, job queue, and chat proxy

## Quick Start

### Gateway

```bash
cd gateway
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

### Dashboard

```bash
cd dashboard
npm install
npm run dev
```

## Deployment

Each workspace runs its own gateway instance. The dashboard connects to one or more gateways.

```
ssh user@vps → clone repo → cd gateway → claude
  → /init-workspace
  → /add-integration
  → /add-agent
  → /add-page
  → /deploy-gateway
```
