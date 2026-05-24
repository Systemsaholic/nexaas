# Approval with free-text follow-up

*v0.1 — framework-side primitives shipped (#45 Stage 1a, framework__request_match), pattern documented from issue triage. Awaiting first canary validation (Phoenix HR onboarding — Mireille's [Reject]/[Need Info] reason capture); will be promoted to v0.2 once landed.*

Pattern for skills that present an approval prompt with action buttons and need to capture **free-text follow-up** when the human picks a button that requires more context. Channel-agnostic — works for any channel the workspace has bound that supports inline buttons + reply capture (Telegram, Nexmatic dashboard, Slack, future SMS).

The canonical example is rejection-with-reason: a skill writes a draft, the operator clicks `[Reject]`, the skill needs to know **why** before closing the row. The same shape covers any "button click + 1 free-text reply" follow-up.

Unblocks flows like:

- HR onboarding rejection: `[Reject]` → "Why are you rejecting this application?"
- Sales-call confirmation: `[Need Info]` → "What information do they need first?"
- Ops escalation: `[Defer]` → "What's the unblock?"
- Marketing approval: `[Edit]` → "What would you like changed?"

## When to use this pattern

- The skill produces an output that needs human approval
- One or more of the available decisions cannot stand alone — the operator's *reason* or *amendment* is part of the decision
- The follow-up is **one** free-text reply, not a multi-turn conversation (multi-turn is its own pattern, not yet documented)

## When **not** to use

- Approval is binary and the framework's `decisions[{id, label}]` plus the routing engine's `auto_execute` / `approval_required` / `escalate` is enough — don't bolt on an unnecessary text capture
- The "follow-up" is structured enough to be its own button — model it as additional decisions instead (`[Reject — wrong region]`, `[Reject — missing info]`, …)
- The skill needs an open-ended back-and-forth — that's the conversation pattern, which uses repeated `framework__request_match` calls in a loop

## Two surfaces — pick the right one

### Surface 1: AI skill with `framework__request_match`

The common case. The skill's agentic loop produces an output via `framework__produce_output`, the routing engine routes via `approval_required`, and on resume the skill detects the chosen decision and calls `framework__request_match` to capture the follow-up reply.

```ts
// Inside the skill prompt's instructions to Claude:

// Step 1: produce the output that needs approval
framework__produce_output({
  output_id: "draft_decision",
  payload: { ...whatever the skill produced... },
})
// Returns: { ok: true, status: "pending_approval", ... }
// Skill is now suspended on a TAG-emitted approval-request waitpoint.
// Telegram/dashboard/etc. shows the prompt with [Approve][Reject][Need Info].

// === Operator clicks a button ===
// approval-resolver (#45 Stage 1a) writes resolved_with: { button_id: "reject", … }
// Skill resumes here.

// Step 2: branch on the chosen decision
const decision = ctx.resolved_with.button_id   // "approve" | "reject" | "need_info"

if (decision === "approve") {
  // Done — the routing engine already executed the original output.
  // No follow-up needed.
  return
}

if (decision === "reject" || decision === "need_info") {
  // Send a follow-up prompt over the SAME channel binding so the
  // operator sees the question in the same conversation thread.
  framework__produce_output({
    output_id: "followup_question",
    payload: {
      content:
        decision === "reject"
          ? "Why are you rejecting this? Reply with the reason in one message."
          : "What information do they need first? Reply with details in one message.",
    },
  })

  // Wait for the operator's next message in the same room.
  const reply = framework__request_match({
    channel_role: "<the role bound to this operator>",
    content_pattern: "any",
    sender_id: ctx.resolved_with.from_id,        // restrict to this operator
    timeout_seconds: 3600,
    extract: "full_content",
  })

  // reply.content is the operator's free-text answer.
  // Use it for the appropriate downstream action — write a rejection
  // record, schedule a discovery call, etc.
}
```

The `sender_id` restriction is critical. Without it, *any* message landing in the room (a different operator's reply, an unrelated notification echo) would resolve the waitpoint. Pin it to the same `from.id` that resolved the button click — the skill can read it from `ctx.resolved_with`.

### Surface 2: shell skill with the HTTP API

Same shape, but the shell skill drives both waitpoints itself via `POST /api/waitpoints/inbound-match`. Useful for non-AI skills (cron-driven shell scripts) that need the same approval-then-follow-up primitive. See `2fa-code-intercept.md` § "Surface 1: HTTP API" for the canonical request/response shape — the only difference here is you'd register two consecutive waitpoints (button match, then any-content match) in the same script.

## Manifest declaration

In the skill's `skill.yaml`:

```yaml
outputs:
  - id: draft_decision
    routing_default: approval_required
    approval:
      channel_role: hr_lead              # who sees the prompt
    decisions:
      - id: approve
        label: Approve
      - id: reject
        label: Reject
      - id: need_info
        label: Need Info

  - id: followup_question
    routing_default: auto_execute        # plain notification, no approval
    notify:
      channel_role: hr_lead              # same channel as the approval
```

The `decisions` field is what TAG (#45 Stage 1a) renders into channel-shaped `inline_buttons`. The `followup_question` output is just a notification — its only job is to ask the question; the answer comes back through `framework__request_match`, not through another approval.

## Channel-binding hint

Both the original approval and the follow-up question route through the same `channel_role`. Verify in the workspace manifest that the binding's MCP supports both inline buttons (for the approval) **and** reply capture (for the follow-up):

| Channel | Inline buttons | Reply capture | Notes |
|---|---|---|---|
| Telegram | yes — `inline_buttons[{text, button_id}]` | yes — bot receives the next message in the same chat | Requires the bot to be in the chat; for DMs, the operator must have started a chat with the bot at least once |
| Nexmatic dashboard | yes — `inline_buttons` rendered in the inbox UI | yes — the dashboard's reply box writes to the same room | The `pa_reply_<role>` convention applies; Mireille's `pa_reply_mireille` is the analogue |
| Slack | yes — `block_actions` | yes via `event_callback` | Adapter must be configured for both event types |

## Gotchas

### Race: button click resolves before the skill registers the follow-up waitpoint

The approval-resolver writes `resolved_with` and re-enqueues the skill *immediately* on button click. The skill then runs Step 2, which produces the follow-up question and registers the second waitpoint. Between the two registrations, the operator could (if they're fast) send a reply that doesn't match anything yet.

The framework handles this correctly: `framework__request_match` is registered before the skill prints the follow-up question's content (the message hasn't gone out yet — production happens via the routing engine which fires on next tick), so the operator has nothing to reply to until after registration. But shell-skill drivers using the HTTP API directly should be careful to register the second waitpoint *before* sending the follow-up message themselves.

### Wrong-operator reply resolves the waitpoint

Always set `sender_id` on the follow-up `request_match`. Without it, any drawer in `inbox.messaging.<role>` resolves — including stale messages, other operators' chatter, or a reply meant for a different prompt. Pin to the operator who clicked the button (`ctx.resolved_with.from_id`).

### Multi-line replies

`content_pattern: "any"` matches any non-empty content, including multi-line. The extracted `content` preserves newlines. Skills that want only the first line should slice after extraction; the framework doesn't impose structure on free-text follow-ups.

### Timeout handling

If the operator never replies, `request_match` resolves with `status: "timeout"` after `timeout_seconds`. Skills should branch on the status:

```ts
const reply = framework__request_match({ ... timeout_seconds: 3600 })

if (reply.status === "timeout") {
  // Decide: re-prompt, escalate, or close as "rejected without reason"
} else if (reply.status === "cancelled") {
  // The waitpoint was cancelled out-of-band (operator killed the run, etc.)
} else {
  // reply.content has the answer
}
```

Don't loop indefinitely without a timeout — that ties up a skill_run forever.

## WAL signature

| Op | When |
|---|---|
| `approval_requested` | Skill produces the approval-shaped output (TAG Stage 1a) |
| `approval_resolved` | Operator clicks a button — approval-resolver records the decision + from.id |
| `framework_request_match_registered` | Skill resumes and registers the follow-up waitpoint |
| `framework_request_match_resolved` | Operator's reply lands — payload includes the extracted content |
| `output_produced` × 2 | One for `draft_decision` (the original output), one for `followup_question` (#86 Gap 1) |

`nexaas verify-wal` will see all five in sequence for a complete approval-with-followup interaction. Useful for post-mortems when an operator says "I clicked Reject and never got asked why" — the absence of the second `output_produced` or `framework_request_match_registered` row tells you exactly which step broke.

## Routing decisions to handler skills

The Surface 1 pattern above runs the **same skill** before and after the operator's decision — Step 1 produces the output, Step 2 resumes after the click. This is fine for simple branching, but as the post-decision logic grows (approve = publish to Zernio + write to promotion log + emit telemetry; reject = archive + email the creator + remove from queue), the original skill becomes a multi-thousand-line conditional. It also bloats the skill_runs row's wall-clock — the run stays open while the operator deliberates for hours.

The framework supports an alternative: **per-decision handler skills**. Each decision routes to a distinct skill that handles its branch, enqueued with the original run's context after the operator clicks.

```yaml
outputs:
  - id: draft_decision
    routing_default: approval_required
    approval:
      channel_role: hr_lead
    decisions:
      - id: approve
        label: Approve
      - id: reject
        label: Reject
    handlers:
      approve: hr/onboarding-publish
      reject:  hr/onboarding-archive
```

When the operator approves, [`approval-resolver.ts`](../packages/runtime/src/tasks/approval-resolver.ts) enqueues a fresh run of `hr/onboarding-publish` with:

```json
{
  "trigger_type": "resumption",
  "trigger_payload": {
    "original_run_id": "<original-skill-run-id>",
    "original_step_id": "draft_decision",
    "decision": "approve",
    "actor": "<operator-id>"
  }
}
```

The handler skill reads `trigger_payload.original_run_id` and fetches the draft via palace lookup — it does NOT receive the original payload directly in the trigger:

```ts
// Inside the handler skill (sketch):
const originalRunId = ctx.trigger_payload.original_run_id

const [draft] = await palace_search({
  // Wherever the original skill wrote its output drawer:
  room: "outputs.hr.onboarding",
  filter: { run_id: originalRunId, output_id: "draft_decision" },
  limit: 1,
})

// Continue with draft.payload — publish or archive
```

The framework keeps `trigger_payload` small (decision + actor + original-run pointers) so handler skills can be replayed deterministically by re-fetching the original output from palace at any later point.

### When to use the handlers map vs. in-skill resume

| Use the handlers map when… | Use in-skill resume when… |
|---|---|
| The branches diverge in scope (different MCPs, different rooms, different downstream effects) | Both branches share most of their logic |
| You want each branch to be independently testable / replayable | The follow-up step is small (one DB write, one notification) |
| Multiple skills produce outputs that route through the same handler (centralize the "publish" path) | The skill is small enough that "resume here" reads better than "call out to another skill" |
| Auditing wants the handler as a distinct `skill_runs` row | You want the entire round-trip captured in one `skill_runs` row |
| The operator might deliberate for hours/days (don't keep the original run open) | The decision is expected within seconds/minutes |

### Handler skill manifest hygiene

- **Handler skills do NOT declare an approval output themselves.** If they did, every approval would loop forever (approve → publish-skill → approve → …). Handlers terminate the decision tree.
- **Handler skills can declare their own `triggers:`** for direct invocation (e.g., a `cron:` or `manual:` trigger so an operator can replay the publish step ad-hoc on a manually-prepared draft). They're not exclusively callable via the handlers map.
- **Concurrency:** if multiple per-decision handlers touch the same external resource (Zernio rate limits, Stripe API, etc.), declare matching `concurrency_groups:` on them so the framework serializes the calls.
- **Channel-agnostic:** the handler doesn't know which channel the operator used to click the button. If the handler needs to send a confirmation back, it routes via the workspace's outbound capabilities like any other skill.

### WAL signature with handlers

Adds one row to the sequence in [WAL signature](#wal-signature) above:

| Op | When |
|---|---|
| `handler_skill_enqueued` | Approval-resolver enqueues the per-decision skill — payload includes `decision`, `handler_skill_id`, `original_run_id` |

It lands between `approval_resolved` and the handler skill's own `skill_run_started`:

```sql
SELECT created_at, op, payload->>'handler_skill_id' AS handler, payload->>'decision' AS decision
  FROM nexaas_memory.wal
 WHERE op = 'handler_skill_enqueued'
 ORDER BY created_at DESC
 LIMIT 10;
```

Adopter dashboards can correlate the original approval with the eventual handler run via `payload->>'original_run_id'`.

### Mixing handlers with `framework__request_match`

The follow-up question pattern from Surface 1 is still available **inside a handler skill** — the handler is just another skill. A `reject` handler that wants the operator's reason can register a `framework__request_match` waitpoint exactly as Step 2 of the in-skill pattern does. The split is orthogonal: handlers map which skill runs; `framework__request_match` captures the free-text follow-up within that skill.

If both branches need free-text follow-up and the branches diverge afterward, the handlers map is the cleaner shape — each branch's `request_match` lives in its own skill.

## Why not a single compound waitpoint primitive?

Issue #67 considered a "compound" waitpoint that resolves on `button_id OR (button_id + followup)` as a single registered primitive. The framework hasn't shipped this — the 2-waitpoint stitch covers the cases seen so far, and a compound primitive would force every adopter to learn a new abstraction. If 3+ adopters file requests for the same shape, the primitive becomes worth the cost.

## Related

- `2fa-code-intercept.md` — the channel-agnostic inbound-match waitpoint primitive that backs `framework__request_match`
- `telegram-channel.md` — channel-specific inbound + outbound for Telegram
- `manifest-hygiene.md` — chat_id types, `channel_role` naming, `channel_bindings` structure
- Framework: `packages/runtime/src/tasks/inbound-match-waitpoint.ts`, `packages/runtime/src/tasks/approval-resolver.ts`, `packages/runtime/src/ai-skill-framework-tools.ts`
