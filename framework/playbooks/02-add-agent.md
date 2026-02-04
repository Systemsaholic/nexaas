# Playbook 02: Add an Agent

Add a new AI agent to your workspace.

## Prerequisites

- Workspace deployed and engine running
- Familiarity with your agent's intended role

## Steps

### 1. Create Agent Directory

```bash
mkdir -p workspace/agents/{{AGENT_NAME}}
```

### 2. Create Config

Copy the template and customize:

```bash
cp framework/templates/agent-config.yaml workspace/agents/{{AGENT_NAME}}/config.yaml
```

Edit `config.yaml`:

```yaml
name: {{AGENT_NAME}}
role: Your Agent's Role
description: What this agent does.
capabilities:
  - chat
```

### 3. Create Prompt (Optional)

```bash
cp framework/templates/agent-prompt.md workspace/agents/{{AGENT_NAME}}/prompt.md
```

Edit `prompt.md` with the agent's system prompt.

### 4. Set Parent (Optional)

To place this agent under another in the hierarchy, add to `config.yaml`:

```yaml
parent: director
```

### 5. Verify

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:8400/api/agents
```

Your agent should appear in the response. If it has a parent, it appears nested in the tree.

## Notes

- Agent names must be lowercase, hyphenated slugs (e.g., `content-writer`)
- If a framework agent has the same name, your workspace version takes precedence
- Changes are picked up on the next API request (no restart needed)
