# `@nexaas/mcp-email-outbound`

MCP server implementing the **email-outbound** capability (capabilities/_registry.yaml v0.2).

Filed against issue #78 (Nexmatic Email Autopilot). Ships with **Resend**, **Postmark**, and **SendGrid**. AWS SES follows in a separate PR (needs SDK choice approval — manual SigV4 vs `@aws-sdk/client-sesv2`).

## Wiring into a skill

In the skill's `skill.yaml`:

```yaml
mcp_servers:
  - email-outbound
```

In the workspace's `.mcp.json`:

```json
{
  "email-outbound": {
    "command": "node",
    "args": ["/opt/nexaas/mcp/servers/email-outbound/src/index.ts"],
    "env": {
      "RESEND_API_KEY": "${env:RESEND_API_KEY}",
      "POSTMARK_SERVER_TOKEN": "${env:POSTMARK_SERVER_TOKEN}",
      "SENDGRID_API_KEY": "${env:SENDGRID_API_KEY}"
    }
  }
}
```

Set whichever provider's credentials apply for the workspace; the MCP only requires one to be present.

The skill agentic loop now sees `send` and `track` tools.

## Provider selection

Order of resolution at server start:

1. **`EMAIL_OUTBOUND_PROVIDER`** env var — explicit pin (`resend` | `postmark` | `sendgrid`; future: `aws_ses`).
2. **Auto-detect** — first key present wins, in this fixed probe order:
   1. `RESEND_API_KEY` → Resend
   2. `POSTMARK_SERVER_TOKEN` → Postmark
   3. `SENDGRID_API_KEY` → SendGrid

The order is fixed (not "first env-var defined") so workspaces with multiple keys configured get deterministic behavior. Operators wanting a non-default pick must use `EMAIL_OUTBOUND_PROVIDER` to pin explicitly.

The chosen provider name is logged on stderr at startup and surfaces in every tool response as `provider:`.

`workspace_kv.email_outbound_provider` is reserved for a future per-workspace override; not honored in PR A because the MCP runs as its own subprocess without a palace session in scope. Operators wanting per-workspace pinning today should set the env var in `.env`.

## Adding a provider

1. Implement `EmailProvider` in `src/providers/<name>.ts`.
2. Add the env-key probe in `src/provider-select.ts`.
3. Update this README's "Provider selection" section.
4. Bump `implementations:` in `capabilities/_registry.yaml`.

The `EmailProvider` interface (in `src/types.ts`) is the contract. Providers translate framework-canonical send/track shapes to whatever their underlying API expects, then translate the response back. Skills never see provider-specific shapes.

## Tool reference

### `send`

```json
{
  "from": { "email": "ops@bsbc.test", "name": "BSBC Ops" },
  "reply_to": "noreply@bsbc.test",
  "to": ["a@example.com", "b@example.com"],
  "subject": "Hello",
  "body_text": "Plain-text body — required for deliverability.",
  "body_html": "<p>Optional HTML.</p>",
  "headers": { "List-Unsubscribe": "<mailto:unsub@bsbc.test>" },
  "tracking": { "opens": true, "clicks": true },
  "tags": ["welcome-sequence"]
}
```

Returns:

```json
{
  "ok": true,
  "provider": "resend",
  "message_id": "01HZ...",
  "accepted": ["a@example.com", "b@example.com"],
  "rejected": []
}
```

### `track`

```json
{ "message_id": "01HZ..." }
```

Returns:

```json
{
  "ok": true,
  "provider": "resend",
  "message_id": "01HZ...",
  "status": "delivered",
  "delivered_at": "2026-05-01T14:22:14Z"
}
```

`opened` / `clicked` counts come via webhook on most providers and aren't exposed by the synchronous track endpoint. Skills needing precise engagement counts should subscribe to a webhook drawer; the MCP's `track` returns last-known synchronous state only.

## Provider notes

### Resend

- Tracking flags (`tracking.opens` / `tracking.clicks`) are configured at the API-key / domain level in the Resend dashboard. Per-message toggles are accepted by this MCP for cross-provider symmetry but **no-op** for Resend — flip the dashboard toggles instead.
- `track` uses `GET /emails/:id` for last-known state. Open/click counts require webhook ingestion (out of scope for PR A).
- Per-recipient rejection isn't returned by Resend's `POST /emails`. On error, all recipients are reported as `rejected` with the provider's error message as the reason.

### Postmark

- Auth: `X-Postmark-Server-Token` (per-server token from the Postmark UI).
- Multi-recipient sends use a single `POST /email` with comma-separated `To` and yield one `MessageID` for the batch. Per-recipient outcomes need `POST /email/batch` — deferred to a follow-up; for now `rejected[]` is empty on accept and contains all recipients on reject (mirroring the framework's coarse-grained shape).
- `tags`: Postmark exposes a singular `Tag` field. The first entry from `tags[]` is sent as `Tag`; remaining entries land in `Metadata` as `tag_1`, `tag_2`, … so they remain filterable in the Postmark Activity view.
- `tracking.clicks`: mapped to Postmark's `TrackLinks` enum — `true` → `"HtmlAndText"`, `false` → `"None"`. For per-format control, configure server defaults in Postmark and leave the framework flag unset.
- `track` reads `GET /messages/outbound/<id>/details` and prefers the most-specific `MessageEvents[]` entry over the top-level `Status`. Open/click counts require separate `/opens` and `/clicks` calls (one per recipient) — skipped here to keep `track` cheap; subscribe to Postmark webhooks for engagement data.

### SendGrid

- Auth: bearer `SENDGRID_API_KEY`.
- `POST /v3/mail/send` returns **202 with no body**; the message id arrives in the `X-Message-Id` response header. Some SendGrid subuser configurations elide the header — when that happens the MCP still returns `accepted`, but `message_id` is omitted, so callers can't `track` that specific send. (SendGrid known quirk.)
- `tags`: mapped to SendGrid `categories[]`. SendGrid caps categories at 10 per send; entries past index 9 are silently dropped (the framework slices defensively).
- `tracking.opens` / `tracking.clicks`: mapped to `tracking_settings.{open_tracking,click_tracking}.enable` per send.
- Plain-text content is required *before* HTML in the `content[]` array (SendGrid schema rule); the provider already orders correctly regardless of caller order.
- `track` calls `GET /v3/messages/<id>` which is part of SendGrid's **paid Email Activity feed**. On 401/403/404 the provider returns `status: "unknown"` rather than throwing, so non-paid accounts get a graceful degradation. For reliable engagement state, subscribe to SendGrid Event Webhooks regardless of plan tier.
