# /new-skill — Create a Nexaas Skill

Create a new skill that runs through the Nexaas pillar pipeline.

The operator will describe what they need: $ARGUMENTS

## Before Starting

1. **Check the palace for existing skills** that might already do what's needed:
   ```
   palace_search(query="<what the operator described>", wing="knowledge")
   ```

2. **Check registered skills** to avoid duplicates:
   ```bash
   nexaas migrate-flow --list
   ```

3. If a similar skill exists, ask: "I found [skill] which does [description]. Should I build on that, or create something new?"

## Phase 1: Identity

Ask the operator:
1. **What does this skill do?** (one sentence)
2. **Category** — which domain? (operations, marketing, accounting, hr, crm, data-sync, custom)
3. **Name** — suggest a descriptive kebab-case name

Generate the skill ID: `{category}/{name}`

## Phase 2: Trigger

Ask: "How should this skill start?"

| Option | Manifest entry |
|--------|---------------|
| On a schedule | `type: cron, schedule: "expression"` |
| When an email arrives | `type: inbound-message, channel_role: email-inbox` |
| When an event fires | `type: event, event: "room.path"` |
| When a webhook is called | `type: webhook, path: "/hooks/..."` |
| Manually from the dashboard | `type: manual` |

If cron: ask for the schedule in human terms ("every 15 minutes during business hours") and convert to cron expression. Remember the workspace timezone from `nexaas config`.

## Phase 3: Execution Type

Ask: "Does this skill need AI reasoning, or is it a simple script?"

| If AI reasoning is needed | If it's a simple script |
|--------------------------|------------------------|
| `execution.type: ai-skill` | `execution.type: shell` |
| Choose model tier: cheap/good/better/best | Specify the command |
| Identify MCP servers needed | No MCP needed |
| Write a prompt.md | No prompt needed |

**Tier selection guide:**
- `cheap` (Haiku) — classification, extraction, validation, sorting
- `good` (Sonnet) — drafting, reasoning, multi-step logic (DEFAULT)
- `better` (Sonnet+thinking) — complex analysis, branching decisions
- `best` (Opus) — creative work, brand voice, highest stakes

## Phase 4: MCP Servers (AI skills only)

Ask: "What systems does this skill need to interact with?"

Check available MCP servers:
```bash
cat ~/Phoenix-Voyages/.mcp.json | python3 -c "import json,sys; [print(k) for k in json.load(sys.stdin)['mcpServers'].keys()]"
```

List the relevant ones in the manifest under `mcp_servers`.

## Phase 5: Palace Rooms

Ask: "What context does this skill need, and where should it store its results?"

**Primary room** — where this skill's output drawers go:
```yaml
rooms:
  primary:
    wing: {category}
    hall: {domain}
    room: {skill-name}
```

**Retrieval rooms** — what context CAG should walk before running:
```yaml
  retrieval_rooms:
    - { wing: knowledge, hall: brand, room: voice }    # if brand-sensitive
    - { wing: knowledge, hall: agents, room: {agent}-prompt }  # if following an agent's behavior
```

Check what rooms exist: `palace_rooms()`

## Phase 6: Outputs and TAG Routing

Ask: "What actions does this skill produce? Which need approval?"

For each output:
```yaml
outputs:
  - id: {action_name}
    routing_default: auto_execute | approval_required | escalate
    overridable: true | false
    overridable_to: [auto_execute, approval_required]  # if overridable
```

**Rules:**
- Financial writes → `approval_required`, `overridable: false`
- Customer-facing sends → `approval_required`, `overridable: true`
- Internal data processing → `auto_execute`
- Unknown/dangerous → `escalate`

## Phase 7: Write the Prompt (AI skills only)

Create `prompt.md` with:
1. Clear role description
2. Step-by-step instructions
3. What tools to use and in what order
4. Expected output format
5. Safety rules / things to never do
6. Self-Reflection Protocol at the end:

```markdown
## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [one paragraph — generic capability description,
no client names, no specific data, no workspace-specific context]
```

## Phase 8: Generate and Validate

1. Create the skill directory:
   ```bash
   mkdir -p ~/Phoenix-Voyages/nexaas-skills/{category}/{name}
   ```

2. Write `skill.yaml` with all fields from above. Always include:
   ```yaml
   timezone: America/Toronto  # or whatever nexaas config shows
   self_reflection: true       # for AI skills
   ```

3. Write `prompt.md` (AI skills only)

4. Register the skill:
   ```bash
   nexaas register-skill ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml
   ```

5. Test with a manual trigger:
   ```bash
   nexaas trigger-skill ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml
   ```

6. Monitor in Bull Board: `http://localhost:9090/queues`

7. Check the result:
   ```bash
   nexaas health
   ```

## Important Rules

- **NEVER use `claude --print` as a shell command.** Always use `execution.type: ai-skill` for Claude-powered work.
- **ALWAYS use the factory (this command).** Bypassing creates skills that don't follow the framework.
- **ALWAYS declare timezone** from workspace config.
- **ALWAYS include self_reflection** for AI skills.
- **ALWAYS check the palace first** for existing skills and context.
