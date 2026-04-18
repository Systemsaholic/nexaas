# /nexaasify — Convert an existing automation to a Nexaas skill

Convert an existing automation (YAML check, shell script, cron job, or manual workflow) into a proper Nexaas skill that runs through the framework.

The operator will describe what to convert: $ARGUMENTS

## Step 1: Identify the Source

Determine what we're converting. Ask if not clear from the description:

**Option A — YAML check** (from `operations/memory/checks/*.yaml`):
```bash
grep -r "$ARGUMENTS" ~/Phoenix-Voyages/operations/memory/checks/*.yaml
```

**Option B — Existing script**:
```bash
ls ~/Phoenix-Voyages/scripts/*${ARGUMENTS}* ~/Phoenix-Voyages/data/*${ARGUMENTS}* 2>/dev/null
```

**Option C — Cron job**:
```bash
crontab -l 2>/dev/null | grep -i "$ARGUMENTS"
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
| YAML check with `agent:` field | `ai-skill` (the agent name maps to MCP servers + prompt context) |
| Script that calls `claude --print` | `ai-skill` (MUST convert, never keep claude CLI invocations) |
| Python script calling APIs | `shell` skill (wrap the script) OR `ai-skill` (if it needs reasoning) |
| Manual workflow with decisions | `ai-skill` with approval gates |

**Agent → MCP mapping**: If the YAML check specifies an `agent:` field, look up that agent's config to find which MCP servers it uses:
```bash
cat ~/Phoenix-Voyages/agents/{agent-name}/config.yaml | grep -A5 mcp_servers
```

## Step 3: Build the Skill

Use the same structure as `/new-skill` Phase 6-8:

### For shell skills:
```yaml
id: {category}/{name}
version: 1.0.0
description: {one line from check description or script purpose}
timezone: America/Toronto

triggers:
  - type: cron
    schedule: "{converted from recurrence field or cron expression}"

execution:
  type: shell
  command: "{the actual command}"
  timeout: {appropriate timeout}
  working_directory: /home/ubuntu/Phoenix-Voyages

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
timezone: America/Toronto

triggers:
  - type: cron
    schedule: "{schedule}"

execution:
  type: ai-skill
  model_tier: {cheap|good|better|best}

mcp_servers:
  - {servers from agent config}

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

self_reflection: true
```

Write `prompt.md` that captures the check's `tasks:` list and `description:` as AI instructions. Include the Self-Reflection Protocol.

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
mkdir -p ~/Phoenix-Voyages/nexaas-skills/{category}/{name}

# Write skill.yaml and prompt.md (AI skills)

# Validate
nexaas dry-run ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml

# Register
nexaas register-skill ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml

# Test
nexaas trigger-skill ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml

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

## Step 6: Contribute to Library

```bash
nexaas library contribute ~/Phoenix-Voyages/nexaas-skills/{category}/{name}/skill.yaml
```

## Rules

- **NEVER keep `claude --print` invocations.** Convert ALL of them to `ai-skill` type.
- **NEVER hardcode model names.** Use `model_tier: cheap|good|better|best`.
- **ALWAYS include timezone** from `nexaas config`.
- **ALWAYS include Self-Reflection Protocol** for AI skills.
- **ALWAYS validate with `nexaas dry-run`** before registering.
- **ALWAYS test with `nexaas trigger-skill`** before considering it done.
