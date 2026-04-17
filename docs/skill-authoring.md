# Nexaas Skill Authoring Guide

**Document status:** Canonical reference for building skills on the Nexaas framework
**Last updated:** 2026-04-17

---

## 1. What Is a Nexaas Skill

A skill is a unit of work that runs through the Nexaas framework. There are two execution types:

### Shell Skills

Simple command execution — bash scripts, Python scripts, CLI tools. These bypass the pillar pipeline entirely. They schedule, execute a command, and record the result. Use for:

- Cron job replacements (bank sync, lead polling, status checks)
- Script wrappers that don't need AI reasoning
- Health checks and monitoring

Shell skills are **not real Nexaas skills** — they're a migration convenience. They don't use CAG, RAG, TAG, or the model gateway. They run a command and log the output.

### AI Skills (the real thing)

These are what Nexaas is built for. AI skills run through the **full pillar pipeline**:

1. **Connect to MCP servers** — stdio-based tool servers declared in the skill manifest
2. **Assemble context (CAG)** — walk the palace for relevant prior state
3. **Run the agentic loop** — Claude calls MCP tools iteratively until the task is complete
4. **Record everything** — every tool call, every turn, every result becomes a palace drawer
5. **Enforce policy (TAG)** — route outputs through the layered policy engine
6. **Track cost and usage** — token counts, model attribution, per-run cost

AI skills are the proof that Nexaas works. Converting a workflow to an AI skill is called **"nexaasifying"** it.

---

## 2. The Nexaasification Process

"Nexaasifying" means converting an existing automation (Trigger.dev task, n8n workflow, cron script, manual process) into a proper Nexaas AI skill that runs through the pillar pipeline.

### What changes when you nexaasify

| Before (legacy) | After (nexaasified) |
|---|---|
| Claude Code CLI subprocess (`claude --print`) | Claude Agent SDK via the ModelGateway |
| Shell scripts wrapping API calls | MCP servers providing capability tools |
| State in local files or databases | State in palace drawers |
| Logging to stdout/files | WAL-recorded audit trail with hash chain |
| No policy enforcement | TAG routes every output through layered policy |
| No cost tracking | Per-run token usage and cost recorded |
| No context from prior runs | CAG walks palace rooms for relevant history |
| Max subscription billing | API key billing with tier-based model selection |

### Common anti-patterns to avoid

**Anti-pattern: `claude --print` as a shell command**

```yaml
# WRONG — bypasses the entire framework
execution:
  type: shell
  command: "claude --print -m sonnet --mcp my-server 'Do the thing'"
```

This spawns a Claude Code CLI subprocess. It uses your Max subscription (not the API key), doesn't record to the palace, doesn't go through TAG, doesn't track costs, and creates the exact subprocess-spawning pattern Nexaas was designed to eliminate.

**Correct: proper AI skill**

```yaml
# RIGHT — uses the full pillar pipeline
execution:
  type: ai-skill
  model_tier: good

mcp_servers:
  - my-server
```

This calls Claude through the ModelGateway using the Anthropic API key, connects to MCP servers via the stdio protocol, runs an agentic tool-use loop, records everything in the palace, and tracks costs.

**Anti-pattern: hardcoding model names**

```yaml
# WRONG
execution:
  type: ai-skill
  model: claude-sonnet-4-6
```

**Correct: use tiers**

```yaml
# RIGHT — lets the model registry resolve the concrete model
execution:
  type: ai-skill
  model_tier: good  # cheap | good | better | best
```

Tiers decouple skills from specific models. When Anthropic releases a new Sonnet, you update the model registry once and every `good`-tier skill benefits.

**Anti-pattern: no MCP declarations**

If your skill needs to call external tools (email, database, API), it MUST declare MCP servers. Without them, Claude has no tools and the agentic loop ends after one turn with just text output.

---

## 3. Skill Manifest Reference

### Timezone

All cron schedules should declare a timezone. Without one, the system defaults to `America/Toronto` (Eastern Time). The VPS clock runs UTC but cron expressions are interpreted in the declared timezone.

```yaml
timezone: America/Toronto    # skill-level default for all triggers

triggers:
  - type: cron
    schedule: "*/15 8-22 * * *"    # 8am-10pm ET, every 15 min
    timezone: America/Toronto       # per-trigger override (optional)
```

**Always think in the business's timezone, not UTC.** "Business hours" means 8 AM - 8 PM in the timezone where the team operates, not where the server sits.

### Shell Skill

```yaml
id: operations/my-cron-job
version: 1.0.0
description: What this skill does in one sentence
timezone: America/Toronto

triggers:
  - type: cron
    schedule: "*/15 * * * *"    # standard cron expression

execution:
  type: shell
  command: "bash scripts/my-script.sh"
  timeout: 120                   # seconds
  working_directory: /home/ubuntu/MyWorkspace

rooms:
  primary:
    wing: operations
    hall: tasks
    room: my-cron-job

self_reflection: false
```

### AI Skill

```yaml
id: operations/my-ai-task
version: 1.0.0
description: What this skill does in one sentence

triggers:
  - type: cron
    schedule: "*/15 * * * *"

execution:
  type: ai-skill
  model_tier: good              # cheap (Haiku) | good (Sonnet) | better | best (Opus)

mcp_servers:                     # MCP servers from workspace .mcp.json
  - my-email-server
  - my-database-server

rooms:
  primary:
    wing: operations
    hall: tasks
    room: my-ai-task
  retrieval_rooms:               # palace rooms CAG walks for context
    - { wing: knowledge, hall: brand, room: voice }

outputs:
  - id: task_result
    routing_default: auto_execute
    overridable: false

self_reflection: true
```

### Required files per skill

```
nexaas-skills/category/skill-name/
├── skill.yaml     # manifest (required)
├── prompt.md      # AI instructions (required for AI skills)
└── fixtures/      # test data (optional)
```

---

## 4. Model Tier Selection

Choose the right tier for the task complexity:

| Tier | Model | Cost | Use for |
|---|---|---|---|
| `cheap` | Claude Haiku | ~$1/M in, $5/M out | Classification, extraction, validation, sorting, rule-following |
| `good` | Claude Sonnet | ~$3/M in, $15/M out | Drafting, reasoning, multi-step logic, general tasks (DEFAULT) |
| `better` | Claude Sonnet + thinking | ~$3/M in, $15/M out | Complex reasoning, analysis, decision-making |
| `best` | Claude Opus | ~$15/M in, $75/M out | Creative work, brand voice, nuanced judgment, highest stakes |

**Rule of thumb**: start with `cheap` and upgrade only if the output quality requires it. Email sorting is a `cheap` task. Creative content generation is a `best` task. Most operational tasks are `good`.

**Rate limits matter.** The Anthropic API has per-organization rate limits. Running multiple skills at the `good` or `best` tier simultaneously can hit these limits. Use `cheap` for high-frequency skills to stay within bounds.

**Timezones matter.** VPS clocks run UTC. Business teams work in local time. Always declare `timezone` in skill manifests so cron schedules fire at the right business hours. Default is `America/Toronto` (Eastern Time). Forgetting this means "business hours" skills fire at 4 AM instead of 8 AM.

---

## 5. MCP Server Integration

AI skills connect to MCP servers declared in the workspace's `.mcp.json` file. The Nexaas runtime:

1. Reads `.mcp.json` from `NEXAAS_WORKSPACE_ROOT`
2. Spawns each declared MCP server as a child process via stdio
3. Lists available tools via the MCP protocol
4. Presents tools to Claude with server-prefixed names (e.g., `phoenix-email-info__list_emails`)
5. When Claude calls a tool, routes the call to the right MCP server
6. Returns the result to Claude for the next turn

### MCP tool naming

Tools are prefixed with the server name to avoid collisions. If two MCP servers both have a `search` tool, Claude sees:

- `server-a__search`
- `server-b__search`

The skill manifest declares which servers to connect. Only declared servers are spawned.

### MCP server requirements

- Must implement the MCP stdio protocol (JSON-RPC over stdin/stdout)
- Must respond to `initialize`, `notifications/initialized`, `tools/list`, `tools/call`
- Tool schemas must include `inputSchema` (or `input_schema`) with a valid JSON Schema `type: "object"` definition

### Troubleshooting MCP connections

If an AI skill fails with "MCP server not found in .mcp.json":
1. Check `NEXAAS_WORKSPACE_ROOT` is set in `/opt/nexaas/.env`
2. Verify `.mcp.json` exists at that path
3. Verify the server name in the skill manifest matches the key in `.mcp.json`

If an AI skill fails with "input_schema: Field required":
- The MCP server's tool definitions may use `inputSchema` (camelCase) instead of `input_schema` (snake_case)
- The Nexaas runtime normalizes both formats, but ensure the schema includes `type: "object"` at minimum

---

## 6. The Agentic Loop

AI skills run an agentic loop — a multi-turn conversation between Claude and MCP tools:

```
Turn 1: Claude receives the prompt + tool list
        Claude calls: list_emails(mailbox="INBOX", limit=20)

Turn 2: Claude receives tool result (20 email summaries)
        Claude calls: read_email(uid="123"), read_email(uid="456"), ...

Turn 3: Claude receives email contents
        Claude calls: move_email(uid="123", dest="INBOX.Marketing"), ...

Turn 4: Claude says "Done. Sorted 4 emails into 3 folders."
        stop_reason: "end_turn" → loop ends
```

Each turn is recorded in the WAL with:
- Turn number
- Tool calls made (names)
- Token usage (input + output)
- Whether this was the final turn

The loop runs up to 20 turns by default. If Claude hasn't finished by turn 20, the skill is marked as completed with whatever progress was made.

---

## 7. Palace Recording

Every skill run produces palace drawers:

- **Skill result drawer** — written to the skill's primary room with success/failure, turn count, tool call count, token usage
- **WAL entries** — one per agentic turn, plus completion/failure entries
- **`skill_runs` row** — denormalized status tracking (running → completed/failed)

The palace is the audit trail. Every action the AI took is recorded and queryable:

```sql
-- What did the email-sorting skill do in the last hour?
SELECT id, op, left(payload::text, 200)
FROM nexaas_memory.wal
WHERE actor LIKE '%email-sorting%'
  AND created_at > now() - interval '1 hour'
ORDER BY id DESC;
```

---

## 8. Registering and Running Skills

### Register a skill with the scheduler

```bash
nexaas register-skill /path/to/skill.yaml
```

This reads the manifest, registers cron triggers with BullMQ, and confirms.

### Manually trigger a skill

```bash
nexaas trigger-skill /path/to/skill.yaml
```

This enqueues a one-time job immediately, bypassing the cron schedule.

### Check status

```bash
nexaas status
```

Shows worker health, registered workspaces, active runs, API key validity.

### View the dashboard

Open `http://<vps>:9090/queues` in a browser to see Bull Board — active jobs, completed, failed, delayed, with full details.

---

## 9. Migration Workflow

Converting existing automations to Nexaas skills follows this pattern:

1. **Identify** the existing automation (Trigger.dev task, n8n workflow, cron script)
2. **Analyze** what it does: trigger type, integrations, AI involvement, risk level
3. **Choose** execution type: `shell` for simple scripts, `ai-skill` for Claude-powered work
4. **Write** the skill manifest (`skill.yaml`) and prompt (`prompt.md` for AI skills)
5. **Register** with `nexaas register-skill`
6. **Test** with `nexaas trigger-skill` to verify it works
7. **Disable** the legacy automation (Trigger.dev schedule, n8n workflow, cron job)
8. **Monitor** via Bull Board and `nexaas status` for at least one full business cycle
9. **Revert** if needed — re-enable the legacy automation in under 30 seconds

### Risk-based migration order

1. **Tier 1**: Read-only, internal (health checks, status sync) — migrate first
2. **Tier 2**: Low-risk writes (lead sync, data imports) — migrate second
3. **Tier 3**: Customer-adjacent (email sorting, content scheduling) — shadow mode recommended
4. **Tier 4**: Customer-facing (email sending, accounting) — shadow mode required
5. **Tier 5**: Financial (payments, trust reconciliation) — last, with full verification

---

## 10. Lessons from Phoenix Deployment

Real-world findings from the first Nexaas production deployment:

**Shell skills are rock solid.** 389 completions, 0 failures over 6+ hours. BullMQ cron scheduling works exactly as expected. Use shell skills for anything that doesn't need AI.

**AI skills need proper MCP integration.** The `claude --print` shell hack bypasses everything the framework provides. Always use `execution.type: ai-skill` for Claude-powered work.

**Model tier matters for rate limits.** A 10K tokens/min rate limit on the API key means high-frequency Sonnet calls will hit limits. Use Haiku (`cheap` tier) for simple classification tasks — it's 15x cheaper and avoids rate limit issues.

**MCP servers have startup latency.** The first tool call in an AI skill takes 2-5 seconds as the MCP server process spawns. Subsequent calls in the same agentic loop are fast because the connection stays open.

**The agentic loop is the core innovation.** Multi-turn Claude + MCP tool use, recorded in the palace WAL, is what makes Nexaas different from a job queue. The email-sorting skill completed in 4-5 turns with 9-13 tool calls — reading emails, classifying, and sorting — all autonomously.

**Bull Board is essential for operational visibility.** Without it, you're blind to what's running. Every Nexaas install should expose Bull Board on a local port.

**Cross-workspace support is needed from day one.** Phoenix has two workspaces (Phoenix-Voyages + Accounting) on one VPS. They share the Nexaas runtime but have separate palace scopes. Cross-workspace event triggers allow accounting flows to be triggered by main workspace events.
