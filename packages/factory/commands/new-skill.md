# /new-skill — Create a Nexaas Skill

Create a new skill that runs through the Nexaas pillar pipeline.

The operator will describe what they need: $ARGUMENTS

**Canonical manifest reference: `docs/skill-authoring.md`** (in the framework
repo, `$NEXAAS_ROOT/docs/`). This command is the interview workflow; that doc
is the schema. When they disagree, the doc wins — read it before generating.

Workspace paths below use `$NEXAAS_WORKSPACE_ROOT` (set in the environment on
every Nexaas VPS). Never hardcode a client's directory.

## Before Starting

1. **Check the palace for existing skills** that might already do what's needed:
   ```
   palace_search(query="<what the operator described>", wing="knowledge")
   ```

2. **Check registered skills** to avoid duplicates:
   ```bash
   ls $NEXAAS_WORKSPACE_ROOT/nexaas-skills/*/
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

The framework implements exactly these trigger types (see
`docs/skill-authoring.md` § Triggers — `event` and `webhook` do NOT exist):

| Option | Manifest entry |
|--------|---------------|
| On a schedule | `type: cron, schedule: "expression"` |
| When a message/drawer arrives on a channel | `type: inbound-message, channel_role: <role>` |
| When enough items accumulate in a bucket | `type: batch, bucket: <name>, fire_when: {...}` |
| Manually / from a dashboard | no trigger — invoke via `nexaas trigger-skill` or `POST /api/skills/trigger` |

If cron: ask for the schedule in human terms ("every 15 minutes during
business hours") and convert to cron expression. Timezone resolution is
per-trigger → manifest `timezone:` → workspace config → UTC. Check the
workspace's setting with `nexaas config timezone` and declare it in the
manifest rather than assuming.

## Phase 3: Execution Type

Ask: "Does this skill need AI reasoning, or is it a simple script?"

| If AI reasoning is needed | If it's a simple script |
|--------------------------|------------------------|
| `execution.type: ai-skill` | `execution.type: shell` |
| Choose model tier: cheap/good/better/best | Specify the command |
| Identify MCP servers needed | No MCP needed |
| Write a prompt.md | No prompt needed |

**Tier selection guide** (never hardcode model names — tiers only):
- `cheap` — classification, extraction, validation, sorting
- `good` — drafting, reasoning, multi-step logic (DEFAULT)
- `better` — complex analysis, branching decisions
- `best` — creative work, brand voice, highest stakes

Shell skills: `execution.timeout` is **milliseconds**.

## Phase 4: MCP Servers (AI skills only)

Ask: "What systems does this skill need to interact with?"

Check available MCP servers:
```bash
node -e "console.log(Object.keys(require(process.env.NEXAAS_WORKSPACE_ROOT + '/.mcp.json').mcpServers).join('\n'))"
```

Declare them under `mcp_servers`, and **allowlist tools per skill** (#196) —
pushing a 50-tool MCP's full catalog into the system prompt causes silent
first-call timeouts:

```yaml
mcp_servers:
  - id: firecrawl
    tools: [firecrawl_search]   # only what the skill actually uses
  - palace                       # bare string = all tools (small MCPs only)
```

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
```

Check what rooms exist: `palace_rooms()`. New wings must be registered in
`palace/ontology.yaml` (CI-guarded).

## Phase 6: Outputs and TAG Routing

Ask: "What actions does this skill produce? Which need approval?"

Full output schema (kinds, approval blocks, verify, `parse_mode`) is in
`docs/skill-authoring.md` § Outputs. The short form:

```yaml
outputs:
  - id: {action_name}
    routing_default: auto_execute | approval_required | escalate
    required: true      # skill FAILS if it never produces this (#180) —
                        # set for the skill's reason-to-exist output
```

**Routing rules:**
- Financial writes → `approval_required`, `overridable: false`
- Customer-facing sends → `approval_required`, `overridable: true`
- Internal data processing → `auto_execute`
- Unknown/dangerous → `escalate`

## Phase 7: Limits and Concurrency (AI skills)

Defaults: 10 turns, $2.00 spend cap per run. Raise deliberately, not
reflexively:

```yaml
limits:
  max_turns: 10
  max_spend_usd: 2.0
```

If the skill touches a shared resource (a SQLite file, an inbox, a rate-limited
API), serialize with a mutex group (#95):

```yaml
concurrency_groups: ["{resource-name}"]        # "{field}" placeholders allowed
```

## Phase 8: Write the Prompt (AI skills only)

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

## Phase 9: Generate and Validate

1. Create the skill directory:
   ```bash
   mkdir -p $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}
   ```

2. Write `skill.yaml` with all fields from above. Always include:
   ```yaml
   timezone: {workspace timezone from `nexaas config timezone`}
   self_reflection: true       # for AI skills
   ```

3. Write `prompt.md` (AI skills only)

4. Validate, register, and test:
   ```bash
   nexaas dry-run $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml
   nexaas register-skill $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml
   nexaas trigger-skill $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml
   ```

5. Monitor in Bull Board (`http://localhost:9090/queues`), then:
   ```bash
   nexaas health
   ```

## Important Rules

- **NEVER use `claude --print` as a shell command.** Always use `execution.type: ai-skill` for Claude-powered work.
- **ALWAYS use the factory (this command).** Bypassing creates skills that don't follow the framework.
- **NEVER hardcode client paths, client names, or a client's timezone.** `$NEXAAS_WORKSPACE_ROOT` + workspace config only.
- **ALWAYS declare timezone** from workspace config.
- **ALWAYS include self_reflection** for AI skills.
- **ALWAYS check the palace first** for existing skills and context.
