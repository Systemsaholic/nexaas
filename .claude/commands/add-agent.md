# Add Agent

Add a new agent to the workspace interactively.

## Step 1: Agent Identity

Ask:
1. **Agent name** — lowercase, hyphenated (e.g., `email-responder`)
2. **Role** — Short title (e.g., "Email Response Manager")
3. **Description** — What does this agent do?

## Step 2: Hierarchy

List existing agents from `workspace/agents/`:

```bash
ls workspace/agents/
```

Ask: "Is this a sub-agent of an existing agent, or a new root agent?"

If sub-agent, ask which parent.

## Step 3: Capabilities

Ask which capabilities apply:
- `chat` — Interact with users
- `delegate` — Assign tasks to sub-agents
- `monitor` — Watch for events/conditions
- `execute` — Run scripts/webhooks
- `notify` — Send notifications

## Step 4: Create Files

Create `workspace/agents/{name}/config.yaml`:

```yaml
name: {name}
role: {role}
description: {description}
capabilities:
  - {selected capabilities}
parent: {parent or omit}
sub_agents: []
```

Create `workspace/agents/{name}/prompt.md`:

```markdown
You are the {Role} for this workspace.

Your responsibilities:
- {based on description}

Guidelines:
- Read before writing — check current state first
- Report clearly — include actionable output
- Escalate blockers — if you lack access, say so
```

## Step 5: Update Parent (if sub-agent)

If this is a sub-agent, update the parent's `config.yaml` to add this agent to `sub_agents`.

## Step 6: Summary

```
Agent created:
- Config: workspace/agents/{name}/config.yaml
- Prompt: workspace/agents/{name}/prompt.md
- Parent: {parent or "root"}

Test: Open dashboard → Chat → Select {name}
```
