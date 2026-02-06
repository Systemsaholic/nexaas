# Help

List available operator commands.

## Available Commands

| Command | Description |
|---------|-------------|
| `/onboard` | Full workspace setup wizard — agents, registries, MCP, scheduling |
| `/status` | Show workspace health, agents, registries, scheduled tasks |
| `/add-agent` | Add a new agent to the workspace |
| `/add-registry` | Add a new data registry |
| `/add-flow` | Create an automation flow (multi-step workflows) |
| `/add-schedule` | Add a recurring or one-time task |
| `/health` | Quick health check of engine and services |

## Quick Actions

**Check if everything is running:**
```bash
bash scripts/health-check.sh --docker
```

**View engine logs:**
```bash
docker compose logs -f engine
```

**Restart after config changes:**
```bash
docker compose restart engine
```

**Open database:**
```bash
docker compose exec engine sqlite3 /data/nexaas.db
```

## Getting Started

If this is a fresh deployment, run:
```
/onboard
```

This walks you through setting up your company, agents, registries, and integrations.

## Documentation

- Playbooks: `framework/playbooks/`
- Agent template: `framework/templates/`
- MCP catalog: `GET /api/mcp-catalog`

## Need Help?

Describe what you're trying to do and I'll guide you through it.
