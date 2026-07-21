# /nexaasify — Convert an existing automation to a Nexaas skill

Convert an existing automation (YAML check, shell script, cron job, systemd
timer, or manual workflow) into a proper Nexaas skill that runs through the
framework.

The operator will describe what to convert: $ARGUMENTS

Workspace paths use `$NEXAAS_WORKSPACE_ROOT` — never hardcode a client's
directory. Canonical manifest schema: `docs/skill-authoring.md` in the
framework repo.

## Step 1: Identify the Source

Determine what we're converting. Ask if not clear from the description.
Legacy layouts differ per workspace — search broadly:

**Option A — Legacy check/automation definitions** (YAML or config files):
```bash
grep -rl "$ARGUMENTS" $NEXAAS_WORKSPACE_ROOT --include="*.yaml" --include="*.yml" 2>/dev/null | grep -v nexaas-skills | head
```

**Option B — Existing script**:
```bash
find $NEXAAS_WORKSPACE_ROOT -name "*${ARGUMENTS}*" -type f 2>/dev/null | grep -v nexaas-skills | head
```

**Option C — Cron job or systemd timer**:
```bash
crontab -l 2>/dev/null | grep -i "$ARGUMENTS"
systemctl list-timers 2>/dev/null | grep -i "$ARGUMENTS"
```

**Option D — Manual workflow described by the operator**

For each source found, show:
- What it does (read the script/check definition)
- How it's triggered (cron, event, manual)
- What tools/services it uses
- Current status (is it running? when did it last run?)

## Step 2: Analyze & Classify

Determine the Nexaas skill type:

| Source Pattern | Nexaas Skill Type |
|---------------|------------------|
| Shell script, simple command | `shell` skill |
| YAML check with an `agent:` field | `ai-skill` (the agent's config maps to MCP servers + prompt context) |
| Script that calls `claude --print` | `ai-skill` (MUST convert, never keep claude CLI invocations) |
| Script calling APIs, no reasoning | `shell` skill (wrap the script) |
| Manual workflow with decisions | `ai-skill` with approval gates |

**Agent → MCP mapping**: if the legacy system had per-agent config declaring
tools/MCP servers, read that config to seed the skill's `mcp_servers` list —
then allowlist only the tools the skill actually needs (#196).

## Step 3: Build the Skill

Use the same structure as `/new-skill` (Phases 4–8). Templates — resolve
`{timezone}` from `nexaas config timezone`, never assume one:

### For shell skills:
```yaml
id: {category}/{name}
version: 1.0.0
description: {one line from check description or script purpose}
timezone: {timezone}

triggers:
  - type: cron
    schedule: "{converted from recurrence field or cron expression}"

execution:
  type: shell
  command: "{the actual command}"
  timeout: {timeout in MILLISECONDS, e.g. 120000}
  working_directory: {directory the script expects, under $NEXAAS_WORKSPACE_ROOT}

rooms:
  primary:
    wing: {category}
    hall: {domain}
    room: {name}

self_reflection: false
```

### For AI skills:
```yaml
id: {category}/{name}
version: 1.0.0
description: {one line}
timezone: {timezone}

triggers:
  - type: cron
    schedule: "{schedule}"

execution:
  type: ai-skill
  model_tier: {cheap|good|better|best}

mcp_servers:
  - id: {server}
    tools: [{only the tools this skill uses}]

rooms:
  primary:
    wing: {category}
    hall: {domain}
    room: {name}
  retrieval_rooms:
    - { wing: knowledge, hall: {relevant}, room: {context} }

outputs:
  - id: {action}
    routing_default: auto_execute
    overridable: false

limits:
  max_turns: 10
  max_spend_usd: 2.0

self_reflection: true
```

Write `prompt.md` that captures the check's `tasks:` list and `description:`
as AI instructions. Include the Self-Reflection Protocol.

### Recurrence mapping:
| YAML check field | Cron expression |
|-----------------|-----------------|
| `frequent` or `*/15` | `*/15 * * * *` |
| `hourly` | `0 * * * *` |
| `daily` at hour H | `0 H * * *` |
| `weekly` on day D at hour H | `0 H * * D` (1=Mon) |
| `monthly` at hour H | `0 H 1 * *` |

Business hours only? Add `8-22` in the hour field. Weekdays only? Add `1-5` in the DOW field.

## Step 4: Deploy & Validate

```bash
# Create the skill directory
mkdir -p $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}

# Write skill.yaml and prompt.md (AI skills)

# Validate
nexaas dry-run $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml

# Register
nexaas register-skill $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml

# Test
nexaas trigger-skill $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml

# Verify
nexaas status
```

## Step 5: Retire the Source

After confirming the Nexaas skill works:

**For YAML checks**: Set `status: retired` in the check entry and add a comment:
```yaml
- id: check-whatever
  status: retired  # Replaced by nexaas skill: {category}/{name}
  nexaas_skill: {category}/{name}
```

**For cron jobs**: Comment out the crontab entry with a note.

**For scripts**: Don't delete — leave in place but the Nexaas skill replaces the scheduling.

Then follow the legacy-cleanup checklist in the workspace CLAUDE.md — leaving
retired automations discoverable causes Claude Code sessions to drift back to
old patterns.

## Step 6: Contribute to Library

```bash
nexaas library contribute $NEXAAS_WORKSPACE_ROOT/nexaas-skills/{category}/{name}/skill.yaml
```

## Rules

- **NEVER keep `claude --print` invocations.** Convert ALL of them to `ai-skill` type.
- **NEVER hardcode model names.** Use `model_tier: cheap|good|better|best`.
- **NEVER hardcode client paths, client names, or a client's timezone.**
- **ALWAYS include timezone** from `nexaas config timezone`.
- **ALWAYS include Self-Reflection Protocol** for AI skills.
- **ALWAYS validate with `nexaas dry-run`** before registering.
- **ALWAYS test with `nexaas trigger-skill`** before considering it done.
