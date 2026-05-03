# `@nexaas/email-provider-resend`

Resend implementation of the `email-outbound` capability.

Reference integration — maintained by the Nexaas team. See [issue #88](https://github.com/Systemsaholic/nexaas/issues/88) for the architecture and `/integrations/README.md` for the authoring contract.

## Install

In the workspace manifest:

```yaml
integrations:
  - "@nexaas/email-provider-resend"
```

In `.env`:

```
RESEND_API_KEY=re_...
```

## Capability

| Field | Value |
|---|---|
| Implements | `email-outbound` |
| Compat range | `>=0.2 <1` |
| Provider name (in WAL/logs) | `resend` |

## Quirks (vs other email providers)

- **Per-message tracking toggles are no-op.** Resend configures opens/clicks at the API-key and domain level. The integration accepts `tracking.opens` / `tracking.clicks` for cross-provider symmetry but does not pass them through — flip the toggles in the Resend dashboard instead.
- **No per-recipient rejection on send.** Resend bundles all rejections into a single error. On send failure, the integration returns `accepted: []` and `rejected: [{ email, reason: providerMessage }]` for every recipient.
- **No engagement counts on `track`.** `GET /emails/:id` returns last-known delivery state but open/click counts are webhook-delivered. Skills needing precise engagement counts should subscribe to a Resend webhook drawer and aggregate themselves.

## Migration note

Code originally lived in `mcp/servers/email-outbound/src/providers/resend.ts`. Moved here in #88 Phase 2 to separate vendor implementations from the framework's MCP shell. The shell still imports `ResendProvider` (now `createResendProvider`) statically until Phase 3 introduces the manifest-driven loader; from a runtime perspective nothing changed.
