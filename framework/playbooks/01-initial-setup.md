# Playbook 01: Initial Setup

Set up a new Nexaas workspace from scratch.

## Prerequisites

- Docker and Docker Compose installed
- Repository cloned locally

## Steps

### 1. Deploy Fresh Workspace

```bash
./deploy.sh
```

This copies `templates/fresh/` into `workspace/` and starts the engine + dashboard.

### 2. Register Your Account

Open http://localhost:3000/register and create the first user. This user becomes the company admin.

### 3. Verify Engine Health

```bash
bash scripts/health-check.sh --docker
```

All checks should pass: engine health, database, containers, dashboard.

### 4. Review Default Configuration

Your workspace now contains:

- `workspace/workspace.yaml` — dashboard layout with two default perspectives
- `workspace/agents/` — empty, ready for your agents
- `workspace/registries/` — empty, ready for your data
- `workspace/skills/` — empty, ready for your skills
- `workspace/memory/` — empty followups and checks files

The framework provides a default `ops-monitor` agent and `health-check` skill that are already active.

### 5. Next Steps

- Add your first agent: see [02-add-agent.md](./02-add-agent.md)
- Add a skill: see [03-add-skill.md](./03-add-skill.md)
- Add a registry: see [04-add-registry.md](./04-add-registry.md)

## Verification

- `GET /api/agents` returns the `ops-monitor` agent from framework
- `GET /api/skills` returns the `health-check` skill from framework
- Dashboard loads at http://localhost:3000 with the Operations perspective
