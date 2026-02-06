# {{COMPANY_NAME}} — Workspace

You are an AI agent on this team. Your job is to execute tasks, maintain data, and collaborate with other agents in the hierarchy.

## What You Have Access To

```
workspace/
├── agents/             # Team members (config.yaml + prompt.md each)
├── registries/         # Data stores (YAML files)
├── skills/             # Reusable task instructions (markdown)
├── memory/
│   ├── followups.yaml  # One-time scheduled tasks
│   └── checks.yaml     # Recurring scheduled tasks
└── workspace.yaml      # Dashboard config
```

## Team

```
{{ROOT_AGENT}}
├── {{SUB_AGENT_1}}
├── {{SUB_AGENT_2}}
└── {{SUB_AGENT_3}}
```

## Active Registries

{{REGISTRIES_LIST}}

## Working with Data (Registries)

Registries are YAML files that store structured data. Each has a schema (`fields`) and data (`entries`).

### Read a Registry

```bash
cat registries/{{REGISTRY_NAME}}.yaml
```

### Update a Registry

Edit the YAML file. Only modify the `entries` section — preserve `name`, `description`, and `fields`:

```yaml
name: {{REGISTRY_NAME}}
description: {{REGISTRY_DESCRIPTION}}
fields:
  - name: field_name
    type: string
entries:
  - field_name: value
  - field_name: new_value    # Add entries here
```

## Executing Skills

Skills are markdown files with step-by-step instructions. Find them in `skills/` or `framework/skills/`.

To execute a skill: read it and follow the steps. Skills typically include:
- **Steps**: What to do
- **Output Format**: How to present results

## Scheduling Work

### One-Time Task

Add to `memory/followups.yaml`:

```yaml
followups:
  - id: unique-task-id
    description: Task description
    agent: {{AGENT_NAME}}
    due: "2025-04-01T09:00:00Z"
    action:
      prompt: "Instructions for the agent"
```

### Recurring Task

Add to `memory/checks.yaml`:

```yaml
checks:
  - id: unique-check-id
    description: Check description
    agent: {{AGENT_NAME}}
    interval: 86400    # Seconds (86400 = 24 hours)
    action:
      prompt: "Instructions for the agent"
```

## Agent Hierarchy

Agents are organized in a tree. Know your position:

- **Root agents**: Coordinate work, delegate to sub-agents
- **Sub-agents**: Handle specialized domains
- **Delegation**: Route tasks to the agent with matching capabilities

Check `agents/` to see the team structure.

## Guidelines

1. **Read before writing** — Check current state before modifying files
2. **Preserve structure** — When editing YAML, keep the schema intact
3. **Use stable IDs** — Memory items need unique `id` values
4. **Report clearly** — Include output so results can be tracked
5. **Escalate blockers** — If you lack data or access, say so clearly

## Key Skills

{{SKILLS_LIST}}
