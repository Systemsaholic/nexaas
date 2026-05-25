# External webhook → Nexaas skill

*v0.1 — primitive shipped (migration 017 `inbound_dispatches`; endpoint live since #66). Phoenix Voyages canary pending (media-production flow, #201).*

Pattern for **external systems** (Stripe, Wise, Sentry, DocuSeal, Forminator, Descript, n8n outbox, …) to fire a Nexaas skill by POSTing to the worker's inbound-drawer endpoint. The receiving skill subscribes via `type: inbound-message` and processes the drawer like any other inbound message.

Unblocks flows like:

- Stripe webhook → `payments/subscription-router` skill
- Sentry alert → `ops/issue-router` skill
- Forminator booking → `crm/booking-log` skill
- Wise transfer-completed → `accounting/reconcile-wise` skill
- Descript render-complete callback → `marketing/video-overlay` skill (multi-step external-job chain, see #204)
- Any external SaaS that exposes a `callback_url` or webhook target

## When to use this pattern

- An external system POSTs to a URL when an event happens
- You want a Nexaas skill to handle it (palace integration, WAL audit, retry semantics)
- You don't want to run a long-lived custom sidecar process per provider

## When **not** to use

- The event source is internal to your workspace — use `type: cron` or `type: event` between skills instead
- You need bidirectional real-time (use a WebSocket adapter that owns the connection)
- The event is high-frequency (millions/day) and you don't need per-event durability — use a separate aggregation pipeline and emit summary events into Nexaas

## Endpoint

```
POST <worker-base>/api/drawers/inbound
```

- `<worker-base>` is the worker's HTTP listener — `http://localhost:9090` by default (the `NEXAAS_WORKER_PORT`). In multi-VPS setups, often behind a reverse proxy with TLS.
- **Auth:** `Authorization: Bearer $NEXAAS_CROSS_VPS_BEARER_TOKEN` when the env var is set (default in operator-managed deploys); localhost-only when unset (default in direct-adopter deploys).
- **Body shape:**
  ```json
  {
    "workspace": "<workspace-id>",
    "channel_role": "<role-string>",
    "message": {
      "id": "<adapter-native-id>",
      "content": "...",
      "from"?: "string" | { "id": "...", "name"?: "...", "username"?: "..." },
      "attachments"?: [...]
    }
  }
  ```
- **Response:** `201 Created` with `{ ok: true, drawer_id: "<uuid>" }`.
- **Idempotency:** re-POSTing with the same `message.id` returns the existing drawer (no duplicate write). Send `X-Request-ID: <id>` header for the same effect when `message.id` isn't available.
- **Side effect:** drawer lands at `inbox.messaging.<channel_role>`. The inbound-dispatcher then fans out to every skill with `triggers: [{type: inbound-message, channel_role: <role>}]`.

## Two surfaces — pick the right one

### Surface 1: External SaaS POSTs directly (Caddy-fronted)

For external services whose webhook body **you can fully control** (rare — mostly internal webhooks, or providers that let you template the payload):

```caddy
services.example.com {
    handle /api/inbound/* {
        reverse_proxy 127.0.0.1:9090 {
            header_up X-Forwarded-Proto {scheme}
        }
    }
    # other routes...
}
```

The external system then POSTs to `https://services.example.com/api/drawers/inbound` with the framework body shape above.

### Surface 2: Workspace-side adapter (FastAPI, Flask, Node, …)

The common case. Most external providers send their **native** body shape (Stripe `event` envelope, Wise webhook payload, Forminator form data) — not the framework's `{workspace, channel_role, message}` envelope. Your workspace runs a tiny adapter that:

1. Receives the native webhook
2. Validates the provider's HMAC signature (using the per-provider secret you hold)
3. Forwards to the worker in the framework body shape

```python
# adapter.py — FastAPI sketch
import os, json, requests
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
WORKER = "http://127.0.0.1:9090"
TOKEN = os.environ["NEXAAS_CROSS_VPS_BEARER_TOKEN"]

@app.post("/api/webhooks/descript")
async def descript_webhook(request: Request):
    body = await request.json()
    # Validate Descript HMAC signature here using your shared secret.

    r = requests.post(
        f"{WORKER}/api/drawers/inbound",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "X-Request-ID": f"descript-{body['job_id']}",
        },
        json={
            "workspace": "my-workspace",
            "channel_role": "descript-render-complete",
            "message": {
                "id": f"descript-{body['job_id']}",
                "content": json.dumps(body),    # native body preserved verbatim
                "from": "descript-system",
            },
        },
        timeout=10,
    )
    if not r.ok:
        raise HTTPException(502, f"worker rejected: {r.status_code}")
    return {"ok": True}
```

The subscribed skill receives the drawer and parses `body` from the content field.

## Manifest declaration

In the receiving skill's `skill.yaml`:

```yaml
id: marketing/video-overlay
version: 1.0.0
triggers:
  - type: inbound-message
    channel_role: descript-render-complete
execution:
  type: shell        # or ai-skill
  command: scripts/video_overlay.py
rooms:
  primary: { wing: marketing, hall: video, room: overlays }
```

No `cron:` needed — the skill fires whenever a drawer lands in the subscribed channel role.

## Required primitives

| Primitive | File | Role |
|---|---|---|
| Drawer-inbound HTTP route | `packages/runtime/src/worker.ts` (handler around the `/api/drawers/inbound` route) | Bearer-authed POST entry point |
| Inbound-dispatcher | `packages/runtime/src/tasks/inbound-dispatcher.ts` | Polls fresh drawers, fans out to subscribed skills |
| Manifest loader | `packages/runtime/src/schemas/load-manifest.ts` | Resolves `triggers: [{type: inbound-message, channel_role}]` to skill subscription |
| Fan-out idempotency | migration `017_inbound_dispatches.sql` | Each drawer fires each skill at most once |

## Idempotency

Two layers:

1. **Drawer-level.** The drawer's identity is derived from `message.id` (or `X-Request-ID`). Re-POSTing with the same id returns the existing drawer — no duplicate write.
2. **Fan-out level.** `nexaas_memory.inbound_dispatches` records `(drawer_id, skill_id)` after each fire. A redelivery (or a manual retrigger) fires each subscribed skill at most once per drawer.

This is safe-by-default for any webhook source that does at-least-once delivery (Stripe, Wise, Sentry, GitHub, etc. all do this).

## Security

- **Bearer token:** shared secret in `NEXAAS_CROSS_VPS_BEARER_TOKEN`. Rotate via env reload + worker restart. Treat it like a write-anywhere key — a holder can write a drawer to any workspace whose id they know.
- **Workspace from body:** the framework writes the drawer to the `workspace` specified in the body. The endpoint does not cross-check the bearer against a workspace allowlist.
- **HMAC validation lives in your adapter** (Surface 2). The framework can't validate provider signatures — it doesn't hold the per-provider secrets. If you skip HMAC, any caller who can reach your adapter URL can post fake events.
- **Localhost-only mode** (no bearer set): only loopback callers; safe default for direct-adopter setups where the adapter and worker share a VPS.

## Observation path

| Stage | WAL op | SQL |
|---|---|---|
| Drawer landed | (no WAL op — drawer write only) | `SELECT id, content FROM nexaas_memory.events WHERE wing='inbox' AND hall='messaging' AND room='<channel_role>' ORDER BY created_at DESC LIMIT 5;` |
| Skill fired by dispatcher | `inbound_dispatch_started` | `SELECT * FROM nexaas_memory.wal WHERE op='inbound_dispatch_started' ORDER BY created_at DESC LIMIT 10;` |
| Skill completed | (skill_runs row) | `SELECT skill_id, status, started_at FROM nexaas_memory.skill_runs WHERE started_at > NOW() - INTERVAL '1 hour' ORDER BY started_at DESC;` |
| Duplicate suppressed | (no separate WAL op — silent in `inbound_dispatches`) | `SELECT * FROM nexaas_memory.inbound_dispatches WHERE drawer_id = $1;` — multiple rows for the same drawer mean separate skill subscriptions, not duplicate fires |

## Gotchas

### `channel_role` is a free-string
Pick a name that captures the **source** and **event** — `stripe-subscription-created`, `descript-render-complete`, `forminator-booking-submitted`. Don't include your workspace name (that's in `workspace`, not the role). Hyphenated lowercase is the convention.

### `message.id` must be unique per workspace
Two callers POSTing the same `id` collide on the drawer PK. Use the source system's own id (`stripe_event.id`, `descript_job_id`, `forminator_entry_id`) — they're already unique within their source. Falling back to a random UUID is fine if no source-side id exists.

### `content` is opaque to the framework
The framework writes whatever you POST. Your skill parses it. If you POST stringified JSON (recommended for provider payloads), the skill parses it back. If you POST a flat string, treat it as such. Note: drawers don't have a separate structured-payload field on this path — use `content` as a JSON string and parse in-skill.

### Same-VPS adapter is still typically Surface 2
Even when the adapter and worker share a VPS, Surface 2 (workspace adapter) is usually the right pattern because adapters typically need provider-specific HMAC validation. Surface 1 (direct Caddy → worker) only works for systems that let you control the full body shape — rare in practice.

### Workspace claim is on the honor system
The bearer token doesn't bind to a workspace. A mis-configured adapter could write drawers to the wrong workspace. Validate `workspace` against your own deployment's expected value at the adapter layer.

## Rollback

- **Stop firing the skill:** remove or comment out the `inbound-message` trigger in `skill.yaml`, re-run `nexaas register-skill`.
- **Stop accepting the webhook:** comment out the adapter route or the Caddy block; reload.
- **No state to clean up:** WAL keeps the historical record of every drawer; existing drawers remain readable but no new skill_runs fire.

## Related

- [`2fa-code-intercept.md`](./2fa-code-intercept.md) — same drawer-write primitive, human-driven (operator types the code into a channel adapter that writes the drawer)
- [`multi-vps-channel-relay.md`](./multi-vps-channel-relay.md) — cross-VPS variant where an ops-relay forwards inbound traffic into a client VPS
- [`telegram-channel.md`](./telegram-channel.md) — channel-specific adapter (an applied example of Surface 2)
- Framework code: `packages/runtime/src/worker.ts` (the route), `packages/runtime/src/tasks/inbound-dispatcher.ts` (the fan-out)
- #201 (canary — Phoenix media-production flow)
- #204 (related — proposed first-class external-job waitpoint that would let one skill handle the whole round-trip instead of two)
