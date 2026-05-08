# `@nexaas/mcp-email-outbound`

MCP server implementing the **email-outbound** capability (capabilities/_registry.yaml v0.2).

Filed against issue #78 (Nexmatic Email Autopilot). Ships with **Resend** today; Postmark, SendGrid, and AWS SES follow in a separate PR.

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
      "RESEND_API_KEY": "${env:RESEND_API_KEY}"
    }
  }
}
```

The skill agentic loop now sees `send` and `track` tools.

## Provider selection

Order of resolution at server start:

1. **`EMAIL_OUTBOUND_PROVIDER`** env var — explicit pin (`resend`, future: `postmark` | `sendgrid` | `aws_ses`).
2. **Auto-detect** — first known provider key wins. Today: `RESEND_API_KEY`.

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
