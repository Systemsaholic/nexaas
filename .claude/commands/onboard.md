# Workspace Onboarding

Walk the operator through setting up their workspace after deployment. This is a conversational flow — ask questions, wait for responses, then configure.

## Phase 1: Business Context

Ask the operator:

1. **Company name** — What's your company or project name?
2. **What does your business do?** — One or two sentences.
3. **What do you want to automate?** — Examples:
   - Customer support / email management
   - Content creation / social media
   - Sales / CRM operations
   - Internal operations / reporting
   - Something else (let them describe)

Wait for their responses before continuing.

---

## Phase 2: Update Workspace CLAUDE.md

Using their answers, update `workspace/CLAUDE.md`:

1. Replace `{{COMPANY_NAME}}` with their company name
2. Add a "## About" section with their business description
3. Add their automation goals to provide context for agents

Read the current file first, then edit it.

---

## Phase 3: Design Agent Team

Based on their automation goals, suggest an agent structure. Present options:

**For Customer Support:**
```
support-director
├── email-responder
├── ticket-manager
└── escalation-handler
```

**For Content/Marketing:**
```
content-director
├── content-writer
├── social-media
├── email-campaigns
└── analytics
```

**For Sales/CRM:**
```
sales-director
├── lead-qualifier
├── outreach-manager
└── deal-tracker
```

**For Internal Operations:**
```
ops-director
├── report-generator
├── task-coordinator
└── alert-monitor
```

Ask: "Which structure fits best, or would you like a custom setup?"

If custom, ask them to describe their ideal team structure.

---

## Phase 4: Create Agents

For each agent in the chosen structure:

### 4a. Create config.yaml

Create `workspace/agents/{name}/config.yaml`:

```yaml
name: {agent-name}
role: {Role Title}
description: {What this agent does}
capabilities:
  - chat
  - {other capabilities based on role}
sub_agents:
  - {child agents if any}
```

### 4b. Create prompt.md

Create `workspace/agents/{name}/prompt.md`:

```markdown
You are the {Role Title} for {Company Name}.

Your responsibilities:
- {responsibility 1}
- {responsibility 2}
- {responsibility 3}

When delegating, route to:
- {sub-agent}: for {task type}
```

Ask: "Would you like to customize any agent's prompt, or are the defaults good?"

---

## Phase 5: Create Registries

Based on their use case, suggest registries:

**For Customer Support:**
- `tickets` — id, customer, subject, status, priority, assigned_agent
- `customers` — name, email, plan, last_contact
- `templates` — name, category, content

**For Content/Marketing:**
- `content-drafts` — title, type, status, author, due_date
- `campaigns` — name, channel, status, start_date, metrics
- `social-posts` — platform, content, scheduled_for, status

**For Sales/CRM:**
- `leads` — name, company, source, status, score
- `deals` — name, value, stage, owner, close_date
- `contacts` — name, email, company, role, last_touch

**For Internal Operations:**
- `tasks` — title, owner, status, due_date, priority
- `reports` — name, frequency, last_run, recipients
- `alerts` — type, severity, status, created_at

Ask: "Which registries do you need? I can create these or suggest others."

For each selected registry, create `workspace/registries/{name}.yaml` with the schema and empty entries.

---

## Phase 6: Enable MCP Servers

Show available MCP servers:

| Server | Purpose | Requires |
|--------|---------|----------|
| `filesystem` | Read/write workspace files | — |
| `fetch` | Retrieve web content | — |
| `memory` | Persistent key-value store | — |
| `github` | Repo, issues, PRs | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `email` | IMAP/SMTP | `IMAP_HOST`, `SMTP_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` |
| `slack` | Team messaging | `SLACK_BOT_TOKEN` |
| `telegram` | Bot notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

Ask: "Which integrations do you need?"

For servers requiring credentials:
1. Ask if they have the credentials ready
2. If yes, tell them to add to `.env` and we'll enable the server
3. If no, note it as a follow-up task

Update `workspace/.mcp.json`:
```json
{
  "mcpServers": {},
  "enabledFrameworkServers": ["filesystem", "fetch", "{selected servers}"]
}
```

---

## Phase 7: Schedule Initial Tasks

Ask: "Do you want to set up any recurring tasks now?"

Suggest based on use case:

**Customer Support:**
- Daily inbox scan (morning)
- Weekly ticket summary (Friday)
- Daily SLA check

**Content/Marketing:**
- Daily social media check
- Weekly content calendar review
- Monthly analytics report

**Sales/CRM:**
- Daily lead follow-up check
- Weekly pipeline review
- Daily CRM sync

**Internal Operations:**
- Daily status report
- Weekly team summary
- System health check (hourly)

For selected tasks, create entries in `workspace/memory/checks.yaml`:

```yaml
checks:
  - id: {task-id}
    description: {description}
    agent: {assigned-agent}
    interval: {seconds}
    action:
      prompt: "{task instructions}"
```

---

## Phase 8: Update Workspace CLAUDE.md (Final)

Now that everything is configured, update `workspace/CLAUDE.md` with:

1. **Team** section — List the agent hierarchy
2. **Active Registries** section — List registries with descriptions
3. **Key Skills** section — Note any custom skills created
4. **Integrations** section — List enabled MCP servers

---

## Phase 9: Restart Engine

Tell the operator:

```
Configuration complete! Restart the engine to load memory tasks:

docker compose restart engine
```

---

## Phase 10: Summary

Print a summary:

```
========================================
  Workspace Setup Complete!
========================================

Company:     {company_name}
Agents:      {count} agents created
Registries:  {count} registries created
MCP Servers: {list}
Scheduled:   {count} recurring tasks

Files created/updated:
- workspace/CLAUDE.md
- workspace/agents/{list}
- workspace/registries/{list}
- workspace/.mcp.json
- workspace/memory/checks.yaml

Next steps:
1. Restart engine: docker compose restart engine
2. Open dashboard: http://localhost:3000
3. Test agent chat in the Operations perspective
4. Add more agents: /add-agent
5. Add more registries: /add-registry

Need to change something? Just ask!
========================================
```

---

## Notes

- Be conversational — don't dump all questions at once
- Confirm before creating files
- Offer to show file contents before writing
- If they're unsure, provide recommendations based on their use case
- Keep track of what's been created to give accurate summary
