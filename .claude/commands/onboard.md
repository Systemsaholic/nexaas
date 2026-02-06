# Workspace Onboarding

Walk the operator through setting up their workspace after deployment. This is a conversational flow — ask questions, wait for responses, then configure.

## Pre-flight: Detect Deployment Type

Before starting, detect how Nexaas is deployed:

```bash
# Check for Docker
docker compose ps 2>/dev/null | grep -q "engine" && echo "docker" || echo "local"

# Check for systemd service
systemctl is-active nexaas-engine 2>/dev/null && echo "systemd"

# Check for running process
pgrep -f "python server.py" && echo "local-process"
```

Set `DEPLOY_TYPE` based on findings:
- `docker` — Docker Compose deployment
- `systemd` — Systemd service (VPS)
- `local` — Direct process (dev/VPS)

Use this throughout for appropriate commands:

| Action | Docker | Systemd | Local |
|--------|--------|---------|-------|
| Restart engine | `docker compose restart engine` | `sudo systemctl restart nexaas-engine` | `pkill -f server.py && cd engine && python server.py &` |
| View logs | `docker compose logs -f engine` | `journalctl -u nexaas-engine -f` | `tail -f engine/logs/engine.log` |
| Health check | `bash scripts/health-check.sh --docker` | `bash scripts/health-check.sh` | `curl localhost:8400/api/health` |

---

## Phase 0: Website Discovery (Optional)

Ask: "Do you have a company website I can learn from? This helps me understand your business faster."

If they provide a URL:

### 0a. Fetch and Analyze Website

Fetch the homepage and key pages:
- Homepage
- About page (try `/about`, `/about-us`, `/company`)
- Services/Products page (try `/services`, `/products`, `/solutions`)
- Contact page (try `/contact`, `/contact-us`)

For each page, extract:
- **Company name** — from title, logo alt text, or header
- **Business description** — from meta description, hero text, about section
- **Services/Products** — what they offer
- **Industry** — infer from content
- **Contact info** — email, phone, address
- **Social links** — LinkedIn, Twitter, etc.
- **Team members** — if listed on about page
- **Tone/voice** — formal, casual, technical, friendly

### 0b. Present Findings

Show what was discovered:

```
========================================
  Website Analysis: {domain}
========================================

Company:     {company_name}
Industry:    {industry}
Description: {business_description}

Services/Products:
- {service_1}
- {service_2}
- {service_3}

Contact:
- Email: {email}
- Phone: {phone}
- Address: {address}

Social:
- LinkedIn: {url}
- Twitter: {url}

Tone: {formal/casual/technical}
========================================
```

Ask: "Does this look right? Anything to correct or add?"

Let them confirm or adjust before proceeding.

### 0c. Suggest Automation Based on Business

Based on the website analysis, suggest what to automate:

**If they're a service business:**
> "Looks like you offer {services}. Would you like to automate client communication, project updates, or lead follow-up?"

**If they're e-commerce:**
> "I see you sell {products}. Would you like to automate order updates, customer support, or inventory alerts?"

**If they're B2B/SaaS:**
> "You offer {product}. Would you like to automate onboarding emails, support tickets, or usage reporting?"

**If they're an agency:**
> "You provide {services} for clients. Would you like to automate client reporting, content workflows, or project coordination?"

This context flows into Phase 1.

---

## Phase 1: Business Context

If website was analyzed, confirm the extracted info. Otherwise, ask:

1. **Company name** — What's your company or project name?
2. **What does your business do?** — One or two sentences.
3. **What do you want to automate?** — Examples:
   - Customer support / email management
   - Content creation / social media
   - Sales / CRM operations
   - Internal operations / reporting
   - Something else (let them describe)

If website data exists, pre-fill and ask for confirmation:
> "Based on your website, you're {company_name}, a {industry} company that {description}. Is that right?"

Wait for their responses before continuing.

---

## Phase 2: Update Workspace CLAUDE.md

Using their answers (and website data if available), update `workspace/CLAUDE.md`:

1. Replace `{{COMPANY_NAME}}` with their company name
2. Add a "## About" section with their business description
3. Add their automation goals to provide context for agents
4. If website was scraped, add:
   - Industry
   - Key services/products
   - Contact info for reference

Read the current file first, then edit it.

---

## Phase 3: Design Agent Team

Based on their automation goals (and website analysis), suggest an agent structure.

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

**For Agency (if detected from website):**
```
agency-director
├── client-manager
├── project-coordinator
├── content-creator
└── reporting
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

Create `workspace/agents/{name}/prompt.md` using business context:

```markdown
You are the {Role Title} for {Company Name}.

## About {Company Name}
{business_description from website or user input}

## Your Responsibilities
- {responsibility 1}
- {responsibility 2}
- {responsibility 3}

## Services/Products We Offer
{from website analysis if available}

## Tone & Voice
{from website analysis: formal/casual/technical}
Keep communications consistent with our brand.

## When Delegating
Route to:
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

**For Agency:**
- `clients` — name, contact_email, plan, status, start_date
- `projects` — client, name, status, deadline, assigned_team
- `deliverables` — project, type, status, due_date, approved

**Pre-populate from website (if available):**
- If contact info found, offer to create a `company-info` registry with the details
- If team members found, offer to create a `team` registry

Ask: "Which registries do you need? I can create these or suggest others."

For each selected registry, create `workspace/registries/{name}.yaml` with the schema and empty entries.

---

## Phase 6: Enable MCP Servers

Show available MCP servers:

| Server | Purpose | Requires |
|--------|---------|----------|
| `filesystem` | Read/write workspace files | — |
| `fetch` | Retrieve web content | — |
| `playwright` | Browser automation, scraping, screenshots | — |
| `memory` | Persistent key-value store | — |
| `github` | Repo, issues, PRs | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `email` | IMAP/SMTP | `IMAP_HOST`, `SMTP_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD` |
| `slack` | Team messaging | `SLACK_BOT_TOKEN` |
| `telegram` | Bot notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

**Smart suggestions based on website:**
- If email found → suggest `email` server
- If GitHub/code mentioned → suggest `github` server
- If Slack mentioned → suggest `slack` server

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

1. **About** section — Company info (from website + user input)
2. **Team** section — List the agent hierarchy
3. **Active Registries** section — List registries with descriptions
4. **Key Skills** section — Note any custom skills created
5. **Integrations** section — List enabled MCP servers
6. **Contact** section — Company contact info (if scraped from website)

---

## Phase 9: Restart Engine

Tell the operator (based on detected deployment type):

**Docker:**
```
Configuration complete! Restart the engine to load memory tasks:

docker compose restart engine
```

**Systemd (VPS):**
```
Configuration complete! Restart the engine to load memory tasks:

sudo systemctl restart nexaas-engine
```

**Local/Direct:**
```
Configuration complete! Restart the engine to load memory tasks.

If running in foreground, stop it (Ctrl+C) and restart:
cd engine && python server.py

If running in background:
pkill -f "python server.py" && cd engine && nohup python server.py > logs/engine.log 2>&1 &
```

---

## Phase 10: Summary

Print a summary:

```
========================================
  Workspace Setup Complete!
========================================

Company:     {company_name}
Website:     {url if provided}
Industry:    {industry if detected}
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
1. Restart engine (see command above for your deployment type)
2. Open dashboard: http://localhost:3000
3. Test agent chat in the Operations perspective
4. Add more agents: /add-agent
5. Add more registries: /add-registry
6. Check health: /health

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
- Website scraping is optional — works fine without it
- Use WebFetch tool to retrieve website content
- Handle missing pages gracefully (404s are fine, just skip)
