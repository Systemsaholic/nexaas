# Multi-VPS channel relay

*v0.1 — framework primitives shipped 2026-04-20. First canary deployment in progress (Nexmatic Telegram).*

Pattern for operator-managed deployments where one shared inbound channel
(one Telegram bot, one email MX, one SMS number) serves N client VPSes.
Telegram and most chat APIs only allow one webhook per bot — direct
per-VPS ingress doesn't work. This pattern routes the inbound through
an operator-owned relay that forwards canonical drawers into the
correct client VPS.

The single-workspace adapter pattern in
[`telegram-channel.md`](./telegram-channel.md) stays valid for
direct-adopter mode (one VPS, its own bot token, webhook pointed at
itself). This doc covers the *composition* on top.

## When to use this pattern

- **Operator-managed deployment** — you run ≥2 client VPSes behind one
  brand / one shared channel (one bot handle, one email domain, one
  SMS short-code)
- **Channels with one-webhook-per-identity constraints** — Telegram
  (one webhook per bot), email (one MX per domain), Twilio (one URL
  per number), Slack (one Events URL per app)

## When **not** to use this pattern

- **Direct-adopter mode** — one VPS, one bot / domain / number dedicated
  to that workspace. Use [`telegram-channel.md`](./telegram-channel.md)
  directly. The relay adds latency + a dependency for zero benefit.
- **Per-client isolated bots by design** — if the business model calls
  for each client to own their own bot (separate brand, separate
  billing with the provider), skip the relay and treat each VPS as
  direct-adopter.

## Architecture

```
┌──────────────────────┐
│  Provider (Telegram, │
│  SES, Twilio, …)     │
└──────────┬───────────┘
           │  one webhook / MX / hook URL
           ▼
┌──────────────────────────────────────────┐
│  Operator relay VPS (operator-owned)     │
│                                          │
│  1. Accept inbound event                 │
│  2. Extract routing key                  │
│     (Telegram chat_id / email to: /      │
│      SMS destination number / …)         │
│  3. Look up { workspace, vps_host }      │
│     from operator-owned routing table    │
│  4. POST canonical v0.2 drawer to        │
│     https://<vps_host>/api/drawers/      │
│     inbound (Authorization: Bearer …)    │
└──────────┬───────────────────────────────┘
           │  HTTPS over private network,
           │  bearer token
           ▼
┌──────────────────────────────────────────┐
│  Client VPS (framework-owned endpoint)   │
│                                          │
│  POST /api/drawers/inbound               │
│   ↓                                      │
│  writeDrawer(inbox.messaging.<role>)     │
│   ↓                                      │
│  appendWal(inbound_drawer_relayed)       │
│   ↓                                      │
│  (returns 201 with drawer_id)            │
│                                          │
│  Inbound dispatcher poll                 │
│   ↓                                      │
│  matchDrawerAgainstWaitpoints            │
│   + fire subscribed skills               │
└──────────────────────────────────────────┘
```

Outbound is unchanged from
[`telegram-channel.md`](./telegram-channel.md) — each client VPS calls
the provider's API directly. Only the inbound path needs the relay.

## What the framework ships

| Primitive | File | Purpose |
|---|---|---|
| `POST /api/drawers/inbound` | `packages/runtime/src/worker.ts` | Channel-agnostic ingress endpoint; writes canonical `inbox.messaging.<role>` drawer |
| `bearerAuth()` middleware | `packages/runtime/src/middleware/bearer-auth.ts` | Token-gated via `NEXAAS_CROSS_VPS_BEARER_TOKEN` env; 401 on mismatch, pass-through when env unset |
| `POST /api/waitpoints/inbound-match` | `packages/runtime/src/worker.ts` | Same auth guard (relay may also register skill-side waitpoints) |
| v0.2 canonical inbound drawer shape | [`#38`](https://github.com/Systemsaholic/nexaas/issues/38) | `{ id, from, content, timestamp, thread_id?, reply_to?, edited?, attachments?, action_button_click? }` |
| Inbound dispatcher | `packages/runtime/src/tasks/inbound-dispatcher.ts` | Polls `inbox.messaging.*`, fires subscribed skills by `channel_role` |
| WAL op `inbound_drawer_relayed` | emitted from `/api/drawers/inbound` | Audit trail: which relay wrote which drawer for which workspace |

Framework-agnostic to routing: the framework does not store routing
tables, does not know about `chat_id` vs email-address vs phone-number,
does not care which relay wrote the drawer. All the channel-specific
mapping lives in the operator relay.

## What the operator ships

| Piece | Owner | Purpose |
|---|---|---|
| Routing table | Operator (e.g., Nexmatic) | `{ chat_id / to-address / phone → workspace_id + vps_hostname }` — typically backed by the onboarding / channel-settings UI |
| Relay process | Operator | Runs on ops VPS; one webhook per shared identity; forwards to client VPS |
| Bearer token rotation | Operator | Provisions `NEXAAS_CROSS_VPS_BEARER_TOKEN` on each client VPS + in the relay's config; rotates via deploy pipeline |
| Private-network access | Operator | Ensures relay can reach `https://<client_vps>/api/drawers/inbound` without public-internet traversal (Tailscale, WireGuard, VPC, etc.) |

## Example — Telegram

### Relay-side (operator code, Node/Python/Go — whatever)

```ts
// Single webhook registered once with BotFather:
// https://ops.example.com/webhooks/telegram → this handler

app.post("/webhooks/telegram", async (req, res) => {
  const update = req.body;
  const msg = update.message ?? update.edited_message
           ?? update.callback_query?.message;
  const chatId = update.callback_query
    ? update.callback_query.message.chat.id
    : msg.chat.id;

  const route = await routingTable.lookup(String(chatId));
  if (!route) return res.sendStatus(200); // unknown chat → drop silently

  // Build canonical v0.2 drawer
  const drawer = {
    id: String(msg.message_id),
    from: msg.from.username ?? String(msg.from.id),
    content: msg.text ?? "",
    timestamp: new Date(msg.date * 1000).toISOString(),
    ...(msg.reply_to_message && {
      reply_to: String(msg.reply_to_message.message_id),
    }),
    ...(msg.edit_date && { edited: true }),
    ...(update.callback_query && {
      action_button_click: {
        button_id: update.callback_query.data,
        message_id: String(update.callback_query.message.message_id),
      },
    }),
  };

  await fetch(`https://${route.vps_hostname}:9090/api/drawers/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${process.env.NEXAAS_CROSS_VPS_BEARER_TOKEN}`,
    },
    body: JSON.stringify({
      workspace: route.workspace_id,
      channel_role: route.channel_role,       // e.g., "pa_reply_user_a"
      message: drawer,
    }),
  });

  res.sendStatus(200); // ALWAYS 200 back to Telegram; errors are our problem, not theirs
});
```

### Client-VPS-side (framework, nothing to configure)

`/api/drawers/inbound` is already listening on port 9090. Set
`NEXAAS_CROSS_VPS_BEARER_TOKEN=<same-token-relay-uses>` in `.env` and
restart `nexaas-worker.service`. The inbound dispatcher handles the
rest.

### Skill-side (adopter writes skills normally)

```yaml
# skill manifest
id: pa/conversation-turn
execution: { type: ai-skill, model_tier: good }
triggers:
  - type: inbound-message
    channel_role: pa_reply_user_a    # same role the relay writes to
```

The skill is identical to single-VPS mode — it doesn't know or care
that the drawer came via a relay.

## Generalization to other channels

Same topology, different provider-side glue:

| Channel | Relay receives | Routing key | channel_role |
|---|---|---|---|
| Email (SES / Postmark inbound) | JSON webhook or MIME | `to` address or `to+tag@domain` | `email_inbound_<user>` |
| SMS (Twilio) | webhook `POST /sms` | `To` number | `sms_<user>` |
| WhatsApp Business (via BSP) | webhook | `to` wa_id | `wa_<user>` |
| Slack (single app, many workspaces) | Events API | `team_id` / `channel_id` | `slack_<channel>` |

The v0.2 canonical drawer shape handles all of them. Attachments
(files, images, voice) map to the shared `attachments: [...]` array.
Replies / threads map to `reply_to` + `thread_id`.

## Security notes

- **Token transport**: `Authorization: Bearer <token>` over HTTPS.
  Never in query params — logs capture query strings.
- **Token scope**: one shared token across the fleet is fine for v1.
  Per-workspace tokens are a future primitive (reopen [#53](https://github.com/Systemsaholic/nexaas/issues/53)
  if needed) — current relay design writes to one workspace per
  request (`workspace` field in body), so server-side the token only
  authenticates the *caller identity*, not the *target scope*.
- **Network**: prefer private-network transport (Tailscale, WireGuard,
  VPC peering). Public-internet HTTPS works but exposes the endpoint
  to token-brute-force attempts. Rate-limit at the HTTP server /
  reverse proxy layer if you must go public.
- **Rotation**: `.env` change + `systemctl restart nexaas-worker` on
  each client VPS + deploy new token to relay. Tokens are
  constant-time-compared (`crypto.timingSafeEqual`) so no timing
  oracle — but rotate annually or on any suspected leak.
- **Payload validation**: framework validates `workspace`,
  `channel_role`, and `message` shape (must have `content` or
  `attachments` or `action_button_click`). The relay is trusted to
  produce the v0.2 canonical shape — framework rejects malformed
  payloads with 400, not 500.

## Observation

| Signal | Source | SQL |
|---|---|---|
| Relay-originated drawers landed | WAL `inbound_drawer_relayed` op | `SELECT actor, payload FROM wal WHERE op='inbound_drawer_relayed' AND workspace=$1 ORDER BY created_at DESC LIMIT 20;` |
| Relay traffic volume | WAL count | `SELECT date_trunc('hour', created_at) AS h, count(*) FROM wal WHERE op='inbound_drawer_relayed' AND workspace=$1 GROUP BY 1 ORDER BY 1 DESC LIMIT 24;` |
| 401s on the endpoint | HTTP access log / reverse-proxy log | (outside the framework — operator monitoring) |
| Drawer → skill dispatch | `inbound_dispatches` table | `SELECT * FROM inbound_dispatches WHERE workspace=$1 AND dispatched_at > now() - interval '1 hour' ORDER BY dispatched_at DESC;` |
| Drawer → waitpoint resolution | WAL `inbound_match_waitpoint_resolved` op | `SELECT payload FROM wal WHERE op='inbound_match_waitpoint_resolved' AND workspace=$1 ORDER BY created_at DESC LIMIT 10;` |

## Rollback

- **Stop the relay**: disable the operator's webhook handler.
  Inbound stops. Client VPSes' existing state remains intact —
  the dispatcher just stops receiving new drawers.
- **Disable bearer auth on a specific VPS**: unset
  `NEXAAS_CROSS_VPS_BEARER_TOKEN` + restart. Endpoint falls back to
  open-access (framework behavior when env unset). Useful if the
  token is lost and you need to keep the VPS receiving drawers from
  a trusted source while rotating.
- **Full rollback**: revert from relay pattern to per-VPS webhook —
  point the provider webhook at one VPS (will lose multi-tenancy until
  re-routed). Only sensible for emergency isolation, not long-term.

## Known limits

- **Provider → relay reliability is the operator's problem.** Telegram
  retries on 5xx from the webhook but gives up after a few attempts.
  If the relay dies between receiving from Telegram and POSTing to
  the client VPS, the message is lost. Mitigate with relay-side
  retries, a local queue, or idempotency keys in the drawer `id`
  field (dispatcher already deduplicates by `drawer.id`).
- **Ordering across messages from one sender**: relay is free to
  serialize per routing key, or accept parallel fan-in. The framework
  dispatcher processes drawers in `created_at` order per workspace,
  but if the relay POSTs two nearly-simultaneous messages out of
  order, the later one may land first. For conversational skills
  that don't care, this is fine; for strict-order use cases, the
  relay must serialize.
- **No relay-side drawer ID issuance.** The framework generates the
  drawer ID on write. The relay's `message.id` field (set to the
  provider's native message ID) is preserved in the drawer content
  but doesn't become the drawer-table primary key. Treat them as
  separate namespaces.

## Related

- [#38](https://github.com/Systemsaholic/nexaas/issues/38) — v0.2 canonical
  messaging-inbound / -outbound shapes (foundational)
- [#49](https://github.com/Systemsaholic/nexaas/issues/49) — inbound-match
  waitpoint primitive (what relay-written drawers can resolve)
- [#53](https://github.com/Systemsaholic/nexaas/issues/53) — bearer-token
  auth for cross-VPS framework HTTP API
- [#64](https://github.com/Systemsaholic/nexaas/issues/64) — the filing
  question that drove this pattern
- [`telegram-channel.md`](./telegram-channel.md) — single-VPS pattern
  (direct-adopter canonical; still valid for Phoenix-style
  deployments)
