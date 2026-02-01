# Add Agent

You are creating a new agent in this workspace. Walk through each step interactively.

## Step 1: Agent Identity

Ask the user for:
- **Agent name** (lowercase, hyphenated, e.g., `email-responder`)
- **Role** (short description, e.g., "Handles incoming customer emails and drafts responses")
- **Parent agent** (optional) - Show existing agents from `agents/` directory and ask if this is a sub-agent of any of them. If no agents exist yet, skip this.

Wait for their response.

## Step 2: Define Capabilities

Ask the user what this agent should be able to do. Present relevant options based on the role:

- **read** - Read from registries and data sources
- **write** - Write to registries and data sources
- **email** - Send and receive emails
- **chat** - Interact with users via the dashboard
- **schedule** - Create and manage scheduled events
- **delegate** - Delegate tasks to sub-agents
- **approve** - Approve/reject items in queues
- **notify** - Send notifications
- **execute** - Run scripts or webhooks
- **custom** - Define custom capabilities

Let the user select multiple. Also ask about any MCP tools this agent should have access to (reference connected integrations from `.mcp.json` if available).

## Step 3: Create Agent Config

Create the directory `agents/{agent_name}/` and write `agents/{agent_name}/config.yaml`:

```yaml
name: "{agent_name}"
role: "{role_description}"
parent: "{parent_agent_name or null}"
capabilities:
  - {capability_1}
  - {capability_2}
mcp_tools:
  - server: "{mcp_server_name}"
    tools:
      - "{tool_name}"
settings:
  max_concurrent_tasks: 5
  timeout_seconds: 300
  retry_on_failure: true
  log_level: info
created_at: "{iso_date}"
```

Adjust settings based on the agent's role. For example, an email agent might have higher timeout, while a notification agent might have higher concurrency.

## Step 4: Create Agent Prompt

Create `agents/{agent_name}/prompt.md` with a system prompt tailored to the agent's role:

```markdown
# {Agent Name}

You are {agent_name}, an AI agent responsible for {role_description}.

## Your Capabilities
{list capabilities in natural language}

## Guidelines
- Always log your actions for audit purposes
- Escalate to {parent_agent or "the admin"} when uncertain
- Respect rate limits on external services
- Provide clear status updates on long-running tasks

## Context
You operate within the {workspace_name} workspace. {Add relevant business context from CLAUDE.md}
```

Ask the user if they want to customize the prompt further before writing it.

## Step 5: Sub-Agents (Optional)

Ask: "Would you like to create any sub-agents for {agent_name}?"

If yes, recursively run through Steps 1-4 for each sub-agent, setting the parent to the current agent.

## Step 6: Add to Dashboard (Optional)

Ask: "Would you like to add this agent to a dashboard page?"

If yes, read `workspace.yaml` and:
1. Show available perspectives and pages
2. Ask which page to add the agent to
3. Suggest an `agent-chat` component for the agent:

```yaml
- type: agent-chat
  config:
    agent: "{agent_name}"
    title: "Chat with {Agent Name}"
```

Or suggest adding it to an existing `agent-tree` component if one exists.

Update `workspace.yaml` with the new component.

## Completion

Summarize:
- Agent name and role
- Config file path
- Prompt file path
- Parent/child relationships
- Dashboard placement (if any)
- Suggest next steps (add more agents, add events for this agent, test via dashboard)
