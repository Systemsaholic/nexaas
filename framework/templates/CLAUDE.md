# {{COMPANY_NAME}} — Workspace Context

## Platform

This is a Nexaas workspace. Nexaas orchestrates AI agents with an event-driven engine, YAML-based configuration, and a dynamic dashboard.

## Workspace Configuration

- `workspace.yaml` — dashboard layout: perspectives, pages, components
- `agents/` — agent definitions (config.yaml + prompt.md per agent)
- `registries/` — YAML data stores (fields + entries)
- `skills/` — markdown skill definitions
- `memory/` — followups.yaml (one-time) and checks.yaml (recurring)
- `.mcp.json` — MCP server configuration

## Agent Hierarchy

Agents are organized in a tree. Each agent has a `config.yaml` defining its role and capabilities. The `parent` field creates hierarchy. Root agents have no parent.

```
{{ROOT_AGENT}}
├── {{SUB_AGENT_1}}
├── {{SUB_AGENT_2}}
└── {{SUB_AGENT_3}}
```

## Registries

Data is stored in YAML registries under `registries/`. Each registry has typed fields and entries.

Active registries: (list your registries here)

## Key Conventions

- Agent names: lowercase, hyphenated (e.g., `content-writer`)
- Registry names: lowercase, hyphenated (e.g., `client-list`)
- All config is YAML — maintain valid YAML syntax
- Workspace files override framework defaults with the same name

## API Reference

- Engine: http://localhost:8400
- Dashboard: http://localhost:3000
- Health: GET /api/health
- Agents: GET /api/agents
- Events: GET /api/events
- Registries: GET /api/registries
- Skills: GET /api/skills
