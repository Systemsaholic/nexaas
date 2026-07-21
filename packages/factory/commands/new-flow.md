# /new-flow — Create a Nexaas Automation Flow

Build a complete automation flow from a natural language description.

The operator will describe what they need: $ARGUMENTS

A flow is a composition of one or more skills that together accomplish a
business goal. Simple flows may be a single skill. Complex flows chain
multiple skills through the palace: one skill writes drawers, the next
skill's trigger fires on them.

Canonical manifest schema: `docs/skill-authoring.md` in the framework repo.
Workspace paths use `$NEXAAS_WORKSPACE_ROOT` — never hardcode a client's
directory.

## Before Starting

1. **Search the palace** for existing flows and skills that might cover this need:
   ```
   palace_search(query="<what the operator described>")
   palace_rooms(wing="knowledge")
   ```

2. **Check the migration status** for similar existing automations:
   ```bash
   nexaas migrate-flow --list
   ```

3. If similar work exists, propose reuse: "I found [skill/flow] which does [description]. Should I adapt it or build new?"

## Phase 0: Understand the Flow

Parse the operator's description and identify:

1. **What triggers this flow?** (schedule, inbound message, accumulating batch, manual)
2. **What does it need to know?** (context from palace, data from MCP tools, prior run history)
3. **What decisions does it make?** (classify, route, draft, match, reconcile)
4. **What actions does it take?** (send email, write to DB, create document, notify human)
5. **Where does a human need to approve?** (financial writes, customer comms, publishing)
6. **What should it remember for next time?** (results, patterns, preferences)

## Phase 1: Decompose into Skills

Break the flow into discrete skills. Each skill should do ONE thing well.

**Example**: "Process receipts from Telegram, save to Paperless, match to bank transactions in QBO"

Skills:
1. `accounting/receipt-intake` — triggered by Telegram message, OCR the image, confirm with user
2. `accounting/receipt-storage` — save confirmed receipt to Paperless with metadata
3. `accounting/transaction-matcher` — match Paperless receipts to Plaid transactions in QBO

## Phase 2: Build Each Skill

For each skill in the flow, run through the `/new-skill` interview:
- Identity (id, category, description)
- Trigger (cron, inbound-message, batch — see below for chaining)
- Execution type (shell or ai-skill + model tier)
- MCP servers needed (with per-skill tools allowlist, #196)
- Palace rooms (primary output, retrieval context)
- Outputs and TAG routing
- Prompt (for AI skills)

## Phase 3: Wire the Chain

Skills chain through the palace — there is no `emits:`/`type: event`
subscription system. The framework implements exactly three trigger types
(`docs/skill-authoring.md` § Triggers); pick the chaining mechanism per hop:

**Batch bucket (preferred for N-then-process):** upstream writes drawers into
a bucket room; downstream declares a `batch` trigger with fire conditions:

```yaml
# Downstream skill:
triggers:
  - type: batch
    bucket: receipt-confirmed
    fire_when:
      any_of:
        - count_at_least: 5
        - oldest_age_at_least: 3600   # seconds
```

**Inbound-message (for per-item, immediate hops):** upstream's output lands as
an inbound drawer on a channel role; downstream fires per message:

```yaml
triggers:
  - type: inbound-message
    channel_role: receipt-confirmed
```

**Cron sweep (simplest, adds latency):** downstream runs on a schedule and
walks the upstream's primary room for unprocessed drawers.

For guaranteed handoff in a chain, give the upstream skill a `required`
output with `kind: chain_signal` (#180) — the run FAILS loudly if the agent
never produces it, instead of the chain silently stalling.

Cross-workspace hops: write the drawer to the target workspace's worker via
`POST /api/drawers/inbound` (bearer-authenticated, #64) — its inbound
dispatcher takes it from there.

## Phase 4: Define the Contract

For the flow as a whole, define:
- **Approval gates**: which outputs need human review
- **Escalation rules**: when to alert ops
- **Timeout policies**: what happens if a waitpoint expires
- **Access scope**: who can trigger, who can approve

## Phase 5: Generate and Test

1. Create all skill directories and manifests under `$NEXAAS_WORKSPACE_ROOT/nexaas-skills/`
2. Register all skills: `nexaas register-skill <path>` for each
3. Test skill 1 manually: `nexaas trigger-skill <path>`
4. Verify the chain: check that skill 2 fires when skill 1's drawers land
5. Monitor the full chain in Bull Board
6. Run `nexaas health` to verify no failures

## Phase 6: Document

Record the flow in the palace:
```
palace_write(wing="knowledge", hall="flows", room="{flow-name}", content="Flow description + skill chain + trigger wiring")
```

## Important Rules

- **Every skill MUST be created via `/new-skill`.** No hand-written manifests.
- **Every skill MUST go through the Nexaas pillar pipeline.** No `claude --print` hacks.
- **Palace-mediated composition over direct calls.** Skills communicate via drawers + triggers, never by invoking each other.
- **One skill = one responsibility.** Don't build monolithic skills that do everything.
- **Never hardcode client paths, names, or timezones.**
- **Always check the palace first.** Reuse > rebuild.
- **Always test end-to-end** before declaring the flow complete.
