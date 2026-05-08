# `@nexaas/email-provider-sendgrid`

SendGrid implementation of the `email-outbound` capability.

Reference integration — maintained by the Nexaas team. See [issue #88](https://github.com/Systemsaholic/nexaas/issues/88) for the architecture and `/integrations/README.md` for the authoring contract.

## Install

In the workspace manifest:

```yaml
integrations:
  - "@nexaas/email-provider-sendgrid"
```

In `.env`:

```
SENDGRID_API_KEY=SG....
```

## Capability

| Field | Value |
|---|---|
| Implements | `email-outbound` |
| Compat range | `>=0.2 <1` |
| Provider name (in WAL/logs) | `sendgrid` |

## Quirks (vs other email providers)

- **202-with-empty-body on send.** SendGrid's `POST /v3/mail/send` returns `202 Accepted` with no body. The message id arrives in the `X-Message-Id` response header. Some SendGrid subuser configurations elide the header — when that happens the integration returns `accepted` but omits `message_id`, so callers can't `track` that specific send. (Known SendGrid quirk.)
- **`categories[]` capped at 10.** `tags[]` maps to SendGrid `categories[]`; entries past index 9 are silently dropped (the integration slices defensively).
- **`tracking_settings` per send.** `tracking.opens` / `tracking.clicks` map to `tracking_settings.open_tracking.enable` / `tracking_settings.click_tracking.enable`.
- **Plain-text content first.** SendGrid's schema requires `content[]` to list `text/plain` *before* `text/html`. The integration always orders correctly regardless of caller order.
- **`track` requires a paid plan.** `GET /v3/messages/<id>` is part of SendGrid's paid Email Activity feed. On `401` / `403` / `404` the integration returns `status: "unknown"` rather than throwing — graceful degradation for non-paid accounts. Subscribe to SendGrid Event Webhooks for reliable engagement state regardless of plan tier.

## Migration note

Code originally lived in `mcp/servers/email-outbound/src/providers/sendgrid.ts`. Moved here in #88 Phase 2 to separate vendor implementations from the framework's MCP shell. The shell still imports `createSendGridProvider` statically; the manifest-driven loader lands in Phase 3.
