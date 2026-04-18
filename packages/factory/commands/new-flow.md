# /new-flow — Create a Nexaas Automation Flow

Build a complete automation flow from a natural language description.

The operator will describe what they need: $ARGUMENTS

A flow is a composition of one or more skills that together accomplish a business goal. Simple flows may be a single skill. Complex flows chain multiple skills via event-driven triggers.

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

1. **What triggers this flow?** (schedule, email, webhook, manual, event from another flow)
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

Each skill triggers the next via event-driven composition:
- receipt-intake writes to `events.accounting.receipt-confirmed`
- receipt-storage subscribes to that event
- receipt-storage writes to `events.accounting.receipt-stored`
- transaction-matcher subscribes to that event (or runs on cron to batch-match)

## Phase 2: Build Each Skill

For each skill in the flow, run through the `/new-skill` interview:
- Identity (id, category, description)
- Trigger (cron, event, inbound-message, webhook)
- Execution type (shell or ai-skill + model tier)
- MCP servers needed
- Palace rooms (primary output, retrieval context)
- Outputs and TAG routing
- Prompt (for AI skills)

## Phase 3: Wire the Event Chain

If the flow has multiple skills, define the event-driven connections:

```yaml
# Skill 1 emits:
emits:
  - event: accounting.receipt-confirmed
    target_room: { wing: events, hall: accounting, room: receipt-confirmed }

# Skill 2 subscribes:
triggers:
  - type: event
    event: accounting.receipt-confirmed
```

For cross-workspace flows (e.g., Phoenix-Voyages triggers an Accounting skill):
```yaml
emits:
  - event: accounting.new-stripe-payout
    target_workspace: phoenix-accounting
```

## Phase 4: Define the Contract

For the flow as a whole, define:
- **Approval gates**: which outputs need human review
- **Escalation rules**: when to alert ops
- **Timeout policies**: what happens if a waitpoint expires
- **Access scope**: who can trigger, who can approve

## Phase 5: Generate and Test

1. Create all skill directories and manifests
2. Register all skills: `nexaas register-skill <path>` for each
3. Test skill 1 manually: `nexaas trigger-skill <path>`
4. Verify event propagation: check if skill 2 fires when skill 1 completes
5. Monitor the full chain in Bull Board
6. Run `nexaas health` to verify no failures

## Phase 6: Document

Record the flow in the palace:
```
palace_write(wing="knowledge", hall="flows", room="{flow-name}", content="Flow description + skill chain + event wiring")
```

## Important Rules

- **Every skill MUST be created via `/new-skill`.** No hand-written manifests.
- **Every skill MUST go through the Nexaas pillar pipeline.** No `claude --print` hacks.
- **Event-driven composition over sequential chaining.** Skills communicate via palace drawers, not direct calls.
- **One skill = one responsibility.** Don't build monolithic skills that do everything.
- **Always check the palace first.** Reuse > rebuild.
- **Always test end-to-end** before declaring the flow complete.
