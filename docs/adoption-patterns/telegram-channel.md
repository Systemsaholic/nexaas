# Telegram channel adapter

*v0.1 — framework primitives shipped; Phoenix canary validation pending ([#42](https://github.com/Systemsaholic/nexaas/issues/42)).*

Pattern for a workspace that wants to send and receive messages through
Telegram: inbound webhook → skill subscription, outbound skill output →
delivery, and approval button clicks routed back to suspend/resume skill
runs.

The same pattern shape applies to any chat-style channel (Slack, WhatsApp,
Discord, SMS). Replace the adapter's transport code; the framework side is
identical.

## When to use this pattern

- Workspace has a PA ("Personal Assistant") that chats with humans over Telegram
- Skill outputs need human approval before side effects (send email, make payment)
- A Telegram user base exists for operator / end-user notifications

## When **not** to use this pattern

- Pure one-way outbound notifications with no interactivity — use a simpler
  webhook-style MCP without bothering with the inbound-message trigger
- Channels with synchronous request/response semantics (e.g., a CLI) — use
  the PA HTTP adapter (`/api/pa/message`) instead

## Required framework primitives

| Primitive | File | Role |
|---|---|---|
| `messaging-inbound` capability v0.2 | `capabilities/_registry.yaml` | Contract the adapter's inbound MCP must honor (content, attachments, `action_button_click`, `reply_to`, `edited`, etc.) |
| `messaging-outbound` capability v0.2 | `capabilities/_registry.yaml` | `send`, `edit`, `typing_indicator` tools with framework-canonical input shapes |
| Inbound dispatcher | `packages/runtime/src/tasks/inbound-dispatcher.ts` | Polls `inbox.messaging.<role>` drawers, fires subscribed skills |
| Outbound dispatcher | `packages/runtime/src/tasks/notification-dispatcher.ts` | Polls `notifications.pending.*` drawers, invokes the MCP `send` tool, writes delivered/failed receipts |
| Approval resolver | `packages/runtime/src/tasks/approval-resolver.ts` | Correlates inbound button clicks to TAG waitpoints, calls `resolveWaitpoint` |
| TAG route + engine apply | `packages/runtime/src/tag/route.ts` + `engine/apply.ts` | Skill-author-declared routing (`approval_required` etc.) → approval-request drawer |
| Workspace manifest schema | `packages/runtime/src/schemas/workspace-manifest.ts` | Validates `channel_bindings` resolves to a bound MCP |

## Architecture at a glance

```
┌────────────────────────┐
│  Telegram Bot API      │
└──────┬──────────┬──────┘
       │          │
   inbound    outbound
   webhook      HTTPS
       │          ▲
       ▼          │
┌──────────────────────────┐
│  Adapter (workspace-owned MCP)                           │
│                                                          │
│  • POST /webhook/telegram → writes drawer to            │
│    inbox.messaging.<role> with v0.2 canonical shape     │
│                                                          │
│  • `send` tool → Telegram API sendMessage               │
│    `edit` tool → editMessageText                        │
│    `typing_indicator` → sendChatAction                  │
└──────┬───────────────────┬──────────────────────────────┘
       │                   ▲
       ▼                   │ (invoked via MCP by dispatcher)
┌──────────────────────────────────────────────────────┐
│  Nexaas framework (this repo)                        │
│                                                      │
│  • Inbound dispatcher polls inbox.messaging.*       │
│    → fires subscribed skills (BullMQ fanout)        │
│                                                      │
│  • Outbound dispatcher polls notifications.pending. │
│    *                                                 │
│    → invokes adapter's messaging-outbound.send tool │
│                                                      │
│  • Approval resolver                                │
│    → correlates button clicks to TAG waitpoints     │
│    → resolveWaitpoint + outbox re-enqueue           │
└──────────────────────────────────────────────────────┘
```

## Manifest fragments

### Workspace manifest (the adopter maintains per-workspace)

```json
{
  "manifest_version": "0.2",
  "id": "<workspace-id>",
  "name": "<display name>",

  "capability_bindings": {
    "messaging-outbound": {
      "mcp": "telegram-mcp",
      "config": {}
    }
  },

  "channel_bindings": {
    "pa_notify_user_a": {
      "kind": "telegram",
      "mcp": "telegram-mcp",
      "config": { "chat_id": "<chat-id-as-string>" }
    },
    "pa_reply_user_a": {
      "kind": "telegram",
      "mcp": "telegram-mcp",
      "config": { "chat_id": "<chat-id-as-string>" }
    }
  },

  "behavioral_contract": { "approval_posture": "standard" },
  "model_policy":        { "default_tier": "good" }
}
```

> **`chat_id` must be quoted as a string** even though Telegram IDs are
> numeric. The framework does not coerce primitives (see
> [`../skill-authoring.md` §5](../skill-authoring.md) and
> [#50](https://github.com/Systemsaholic/nexaas/issues/50)). Unquoted
> integer chat_ids get rejected by Pydantic-backed MCPs with
> `isError: true`.

### Skill manifest — subscribing to inbound

```yaml
id: pa/conversation-turn
version: 1.0.0
execution:
  type: ai-skill
  model_tier: good

triggers:
  - type: inbound-message
    channel_role: pa_reply_user_a

# Optional: TAG-gate the skill's response
execution:
  primary_output: pa_response

outputs:
  - id: pa_response
    kind: notification
    routing_default: auto_execute
    notify:
      channel_role: pa_reply_user_a
```

The inbound dispatcher reads the manifest at poll time (30s cache) and
matches on `channel_role`. Multiple skills can subscribe to the same role;
they fire in parallel.

### Skill manifest — approval-gated output

```yaml
execution:
  type: ai-skill
  primary_output: send_email_as_user

outputs:
  - id: send_email_as_user
    kind: external_send
    routing_default: approval_required
    approval:
      channel_role: pa_notify_user_a
      decisions: [approve, reject]
      timeout_seconds: 3600
      on_timeout: deny
```

Stage 1a + 1b of TAG ([#45](https://github.com/Systemsaholic/nexaas/issues/45))
route the agentic loop's result through the `approval_required` branch:
waitpoint created, approval-request drawer written to
`notifications.pending.approvals` (with `run_id` in drawer content),
outbound dispatcher delivers with inline buttons.

## Adapter requirements (workspace-owned, not framework code)

### Inbound webhook (adapter-side)

- **Endpoint**: adapter owns it (e.g., `/webhook/telegram` on the
  adapter's HTTP server, secured per Telegram Bot API's secret-token
  mechanism)
- **On receive**: resolve `telegramMsg.from.id` → a
  framework `channel_role` via the adapter's own mapping (hardcoded,
  config file, or querying workspace manifest)
- **Write a drawer** to `inbox.messaging.<role>` matching the v0.2
  canonical shape:

  ```json
  {
    "id": "<telegramMsg.message_id as string>",
    "from": "<username or telegram user id>",
    "content": "<telegramMsg.text>",
    "timestamp": "<ISO 8601>",
    "thread_id": "<reply-to chain id if applicable>",
    "reply_to": "<message_id being replied to>",
    "edited": "<true if edited_date is set>",
    "attachments": [/* { type, url, filename?, mime_type? } */],
    "action_button_click": {
      "button_id": "<callback_query.data>",
      "message_id": "<callback_query.message.message_id as string>"
    }
  }
  ```

  Fields not applicable to the current message are omitted (not `null`).

- **Return 200 immediately.** No Claude call, no `handlePaMessage`, no
  agent logic in the adapter. The inbound dispatcher takes over from here.

### Startup webhook self-check (adapter-side, strongly recommended)

> **Operational gotcha (#116).** Telegram delivers each bot's updates to
> *exactly one* webhook URL. If anything else (a separate FastAPI
> service, a teammate testing locally, a stale `setWebhook` call from
> last week) holds the webhook for the same bot token, your adapter
> sits idle indefinitely with **zero log lines**. Inbound disappears
> silently — Phoenix lost ~6 hours of `insurance_setup:*` button taps
> this way before a human noticed downstream skills weren't firing.

The adapter SHOULD call `getWebhookInfo` on startup and emit a loud
warning when `result.url` does not match the URL it expects to own:

```python
# Adapter startup (Python — language doesn't matter)
async def verify_webhook_ownership(bot_token: str, expected_url: str) -> None:
    async with aiohttp.ClientSession() as s:
        async with s.get(f"https://api.telegram.org/bot{bot_token}/getWebhookInfo") as r:
            info = (await r.json()).get("result", {})
    actual = info.get("url", "")
    if actual != expected_url:
        # 1. Log loud
        logging.warning(
            "telegram webhook owned by %r, expected %r — inbound will NOT reach this adapter",
            actual, expected_url,
        )
        # 2. Write a palace drawer the operator alert flow picks up
        await write_drawer("notifications.alerts.warning", {
            "code": "telegram_webhook_misowned",
            "expected": expected_url,
            "actual": actual,
            "advice": "another service holds setWebhook for this bot token — re-run setWebhook from this adapter or split the bot",
        })
```

Adopters who share a bot token across services should ensure exactly one
service is the canonical webhook owner; everything else should use
`getUpdates` polling or its own dedicated bot.

### Outbound MCP tools (adapter-side)

The adapter's MCP must expose `send`, `edit`, and `typing_indicator`
with the v0.2 shapes. Minimum for this pattern: `send`.

```python
# Adapter MCP (Python / FastMCP example — language doesn't matter,
# protocol is JSON-RPC over stdio)

@tool
def send(
    to: str | int,                      # accept both (see manifest-hygiene)
    content: str,
    parse_mode: str | None = None,      # "markdown" | "html" | "plain"
    inline_buttons: list[dict] | None = None,  # [{ text, button_id }]
    reply_to: str | None = None,
) -> dict:
    resp = telegram_api.send_message(
        chat_id=to,
        text=content,
        parse_mode=_map_parse_mode(parse_mode),
        reply_markup=_build_inline_keyboard(inline_buttons),
        reply_to_message_id=_to_int_or_none(reply_to),
    )
    return {
        "message_id": str(resp["message_id"]),       # framework-level id
        "channel_native_id": str(resp["message_id"]), # for edit/delete later
        "status": "ok",
    }
```

**Map decisions to buttons**: when the adapter receives a `send` call
with `inline_buttons`, translate `button_id` → Telegram's
`callback_data` field one-to-one. When the user taps, the
`callback_query.data` that comes back IS the `button_id` — no
encoding / decoding required on the framework's side.

## Observation path — what operators see

| Stage | WAL op | SQL |
|---|---|---|
| Inbound drawer lands | *(drawer write, no WAL op required)* | `SELECT * FROM events WHERE wing='inbox' AND hall='messaging' AND workspace=$1 ORDER BY created_at DESC LIMIT 10;` |
| Inbound dispatcher fires skill | `inbound_dispatched` | `SELECT * FROM inbound_dispatches WHERE workspace=$1 ORDER BY dispatched_at DESC LIMIT 10;` |
| Inbound-match waitpoint resolves | `inbound_match_waitpoint_resolved` | *(same events table)* |
| Skill produces approval-required output | `tag_routed` + `approval_requested` | `SELECT op, actor, payload FROM wal WHERE workspace=$1 AND op IN ('tag_routed', 'approval_requested') ORDER BY created_at DESC;` |
| Outbound dispatcher delivers | `notification_delivered` | `SELECT status, attempts, channel_message_id FROM notification_dispatches WHERE workspace=$1 ORDER BY claimed_at DESC LIMIT 10;` |
| Button click lands as inbound | *(drawer write with `action_button_click`)* | `SELECT * FROM events WHERE wing='inbox' AND hall='messaging' AND content::jsonb ? 'action_button_click' ORDER BY created_at DESC LIMIT 10;` |
| Approval resolver picks up click | `approval_granted` / `approval_denied` / `approval_resolved` | `SELECT op, payload FROM wal WHERE op LIKE 'approval_%' ORDER BY created_at DESC;` |
| Waitpoint resolution writes drawer | `waitpoint_resolved` | *(same events table)* |

## Known limits

### Inbound
- **Unrecognized channel_role** → adapter can write the drawer, but if no
  skill subscribes, the dispatcher logs `inbound_no_subscriber` and
  records a sentinel row. Operator action: delete the sentinel row if a
  skill is added later and historical drawers should fire retroactively.

### Outbound
- **Per-MCP-call latency**: ~50-200ms for the `send` tool on a warm MCP.
  Cold-spawn adds ~500ms. Volume above ~100/min per workspace may warrant
  MCP connection pooling ([future Stage 2 optimization](https://github.com/Systemsaholic/nexaas/issues/56)).
- **`message_id` vs `channel_native_id`**: the framework returns a generic
  `message_id` field; Telegram-specific follow-ups (edit, delete) use
  `channel_native_id`. Treat them as always-equal for Telegram; other
  channels may differ.

### Approval
- **ai-skill resume after approval is incomplete** — see
  [#53](https://github.com/Systemsaholic/nexaas/issues/53). Skills
  running via `ai-skill.ts` with `approval_required` outputs work for
  one-shot gated delivery; post-approval logic (conditional next steps)
  requires a pattern shift documented in the companion issue.

### Channel-specific
- **Markdown parse quirks**: Telegram's `MarkdownV2` differs from Slack's
  `mrkdwn`. The framework's `parse_mode: "markdown"` is canonical; the
  adapter does the translation. Escaping must happen in the adapter, not
  the skill.

## Rollback

- **Stop the inbound flow**: remove the skill manifest's
  `triggers: [{ type: inbound-message, ... }]`. Dispatcher stops firing.
  Inbound drawers still land; they just don't trigger skills.
- **Stop the outbound flow**: set `channel_bindings.<role>` to an
  unbound role (or remove the binding). Outbound dispatcher marks future
  sends as `notification_skipped` with reason "no channel_binding in
  workspace manifest" — caller sees them stall, doesn't crash.
- **Full rollback of the adapter**: revert to direct `handlePaMessage`
  invocation from the webhook (pre-Stage-1 pattern). Skill runs lose
  the approval round-trip but stay operational.

## Primitives that will improve this pattern (tracked)

- [#39 Stage 2](https://github.com/Systemsaholic/nexaas/issues/39) —
  generic room-pattern dispatcher (replaces the two purpose-built
  inbound + outbound dispatchers with a single mechanism)
- [#45 Stages 2-5](https://github.com/Systemsaholic/nexaas/issues/45) —
  TAG `flag`, `defer`, conditions evaluator, ed25519-signed overrides,
  sub-agent routing inheritance
- [#53](https://github.com/Systemsaholic/nexaas/issues/53) — ai-skill
  post-approval resumption via manifest-declared handler skills
- [#54](https://github.com/Systemsaholic/nexaas/issues/54) — room naming
  cleanup (cosmetic; won't affect adapter behavior)
- [#55](https://github.com/Systemsaholic/nexaas/issues/55) — waitpoint
  API bearer auth for cross-VPS scenarios
- [#37](https://github.com/Systemsaholic/nexaas/issues/37) — compiled JS
  runtime (lower latency, faster worker startup)

## Canary status

- **Framework side**: shipped and running on Phoenix as of 2026-04-20.
  See commits `f7e10c9`, `bb93498`, `472d7f5`, `4fd76ee`, `fc70633`,
  `48688ee`.
- **Adapter side** (Phoenix-owned): refactor in progress per
  [#42](https://github.com/Systemsaholic/nexaas/issues/42).
- **End-to-end validation**: pending Phoenix completing #42.

This document will be revised when Phoenix validates the full round-trip.
Any sections that change materially based on live observation get marked
with the commit that updated them.
