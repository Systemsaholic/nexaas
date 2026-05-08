# `@nexaas/email-provider-postmark`

Postmark implementation of the `email-outbound` capability.

Reference integration — maintained by the Nexaas team. See [issue #88](https://github.com/Systemsaholic/nexaas/issues/88) for the architecture and `/integrations/README.md` for the authoring contract.

## Install

In the workspace manifest:

```yaml
integrations:
  - "@nexaas/email-provider-postmark"
```

In `.env`:

```
POSTMARK_SERVER_TOKEN=...
```

## Capability

| Field | Value |
|---|---|
| Implements | `email-outbound` |
| Compat range | `>=0.2 <1` |
| Provider name (in WAL/logs) | `postmark` |

## Quirks (vs other email providers)

- **Singular `Tag` field.** Postmark's API has one tag per message. The integration sends `tags[0]` as `Tag` and the remainder as `Metadata` (`tag_1`, `tag_2`, …) so they remain filterable in the Postmark Activity view.
- **`TrackLinks` is an enum, not a boolean.** `tracking.clicks: true` → `"HtmlAndText"` (most permissive useful value); `tracking.clicks: false` → `"None"`. For per-format control (HTML-only or text-only), configure the Postmark server defaults and leave the framework flag unset.
- **Single MessageID per send.** Postmark accepts comma-separated `To` and returns one MessageID for the batch. Per-recipient outcomes need `POST /email/batch` — deferred to a follow-up. For now `rejected[]` is empty on accept and contains all recipients on reject (mirroring the framework's coarse-grained shape).
- **`track` skips engagement counts.** `/messages/outbound/<id>/details` returns delivery state, not open/click counts — those need separate `/opens` and `/clicks` calls per recipient. Subscribe to Postmark webhooks for engagement data; the integration prefers the most-specific `MessageEvents[]` entry over the top-level `Status` when normalizing.

## Migration note

Code originally lived in `mcp/servers/email-outbound/src/providers/postmark.ts`. Moved here in #88 Phase 2 to separate vendor implementations from the framework's MCP shell. The shell still imports `createPostmarkProvider` statically; the manifest-driven loader lands in Phase 3.
