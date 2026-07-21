# Security Surface & Secrets

*Shipped for #217 (production hardening T5, umbrella #219). The audit below
reflects the worker as of this document's last update — re-run the
inventory (`grep 'app\.\(get\|post\|delete\)' packages/runtime/src/worker.ts`)
when adding endpoints, and update the table.*

## The worker HTTP surface (`:9090`)

One Express server, port `NEXAAS_WORKER_PORT` (default 9090), bind address
`NEXAAS_WORKER_BIND` (default: **all interfaces**).

`bearerAuth()` (`packages/runtime/src/middleware/bearer-auth.ts`):
- `NEXAAS_CROSS_VPS_BEARER_TOKEN` **unset** → pass-through (open). The
  pre-#217 direct-adopter posture.
- **Set** → every gated route requires `Authorization: Bearer <token>`,
  constant-time compared; `NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS` is also
  accepted during rotation.

| Route | Method | Auth | What it can do |
|---|---|---|---|
| `/health` | GET | open (by design) | liveness JSON — no sensitive data |
| `/queues*` | GET (UI) | **open — bind/firewall-gate it** | Bull Board: job payloads visible, retry/promote actions possible |
| `/api/waitpoints/inbound-match` | POST | bearer | register waitpoint |
| `/api/waitpoints/inbound-match/patterns` | GET | bearer | list named patterns |
| `/api/waitpoints/:id` | GET/DELETE | bearer | read / cancel waitpoint (extracted content may include codes) |
| `/api/skills/trigger` | POST | bearer | enqueue a registered skill |
| `/api/pa/:user/notify` | POST | bearer | PA notification ingress |
| `/api/drawers/inbound` | POST | bearer | write inbound drawers (triggers skills) |
| `/api/pa/message` | POST | bearer *(added #217)* | full PA conversation — **model spend** + palace reads |
| `/api/ingest` | POST | bearer *(added #217)* | chunk + embed — Voyage spend + palace writes |
| `/api/addons/activate` | POST | bearer *(added #217)* | **registers skills and MCP server commands — the most privileged endpoint on the box** |

#217 closed the gap where `/api/pa/message`, `/api/ingest`, and
`/api/addons/activate` stayed open *even with a bearer token configured*.

### Bull Board (`/queues`)

Bearer auth would break browser access, so the dashboard is gated by
network posture instead. It exposes job payloads and allows job actions —
treat it as operator-only:

- Access it over SSH tunnel: `ssh -L 9090:localhost:9090 <vps>` →
  `http://localhost:9090/queues`.
- Never expose 9090 through a reverse proxy without auth on `/queues`.

## Bind & firewall posture by deployment mode

| Mode | Recommended posture |
|---|---|
| **Direct adopter, no off-box callers** (everything on the VPS) | `NEXAAS_WORKER_BIND=127.0.0.1`. Local adapters/scripts keep working; the surface disappears from the network entirely. |
| **Direct adopter with external webhooks** | Bind all interfaces (default) but front with Caddy/nginx (TLS + path allow-list per `docs/adoption-patterns/external-webhook-callback.md`) and firewall 9090 to the proxy. Keep the bearer token set. |
| **Operator-managed (Nexmatic)** | Bind all interfaces; firewall 9090 to the ops-VPS addresses; per-VPS bearer token always set (init does this — below). |

The default bind stays all-interfaces for backward compatibility — the
relay topology depends on it. The knob exists so the common no-off-box-
caller case can opt down to loopback with one env line.

## Per-VPS bearer token

`nexaas init` generates a fresh 64-hex-char token per install and writes it
to `.env` (`NEXAAS_CROSS_VPS_BEARER_TOKEN`). **Never share a token across
VPSes** — one leak must expose one workspace, and per-VPS tokens are
individually revocable on the relay side. Existing installs keep whatever
`.env` already says (init preserves a pre-existing value; pre-#217 installs
remain open until an operator adds a token).

A direct adopter who genuinely wants open endpoints (Phoenix-style, local
callers only): blank the line in `.env` and restart — pass-through returns.
Prefer `NEXAAS_WORKER_BIND=127.0.0.1` over open endpoints when possible.

### Rotation (dual-accept, zero-coordination)

```bash
# 1. On the VPS — keep the old token accepted while senders migrate:
#    .env:
#      NEXAAS_CROSS_VPS_BEARER_TOKEN=<new token>            # openssl rand -hex 32
#      NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS=<old token>
sudo systemctl restart nexaas-worker

# 2. Update every sender (ops relay, webhook adapters) to the new token,
#    at leisure — both tokens authenticate during the window.

# 3. Close the window:
#    remove NEXAAS_CROSS_VPS_BEARER_TOKEN_PREVIOUS from .env
sudo systemctl restart nexaas-worker
```

Tokens are read at worker startup; every step is an `.env` edit + restart
(~5s downtime per restart, queued jobs unaffected).

## Model / provider key rotation

Same mechanics for `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
`RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `NEXAAS_FLEET_TOKEN`:

1. Issue the new key at the provider (both keys valid concurrently —
   Anthropic, Voyage, and Resend all support overlapping keys).
2. Edit `.env`, `sudo systemctl restart nexaas-worker`.
3. Verify: `nexaas health` (live key probe) and/or `nexaas conformance`.
4. Revoke the old key at the provider.

Order matters: provider-side revocation comes **last**. In-flight runs
loaded the old key at process start; the restart in step 2 is what drains
them. For Nexmatic-issued keys the issue/revoke side is operator tooling
(Systemsaholic/nexmatic#11).

## Signing-key backup & recovery

The ed25519 operator signing key is generated by `nexaas init` at
`~/.nexaas/operator-key.ed25519` (0600) — **on disk, not in Postgres**.
`nexaas backup` covers the database; it does not cover this file.

- **Backup**: include `~/.nexaas/` in VPS-level backups, or copy the key
  file alongside the DB dumps (it never changes after init).
- **Restore without the key**: historical WAL signatures still verify (the
  public key is registered in the DB), but the workspace cannot sign new
  privileged entries until an operator re-runs the key bootstrap and
  registers the new public key. Plan for the file, don't plan on the
  fallback.

## Secrets hygiene

- `.env` is 0600 — set by `nexaas init`, re-asserted on every
  `nexaas upgrade` (#217).
- **Never pass secrets on a command line** (visible in process lists and
  shell history) — write `.env` atomically and let the consumer read it.
  This is the provisioning contract in #218.
- `nexaas conformance` includes a `secrets-hygiene` check: `.env`
  permissions, plus every configured secret value grepped against the last
  24h of WAL payloads and ops_alerts. A secret in audited storage means a
  code path is logging something it shouldn't — file it as a framework bug.
- Journald is not automatically audited (root-scoped). Manual spot-check:

  ```bash
  sudo journalctl -u nexaas-worker --since "24 hours ago" | grep -F "$ANTHROPIC_API_KEY" && echo LEAK || echo clean
  ```

## Related

- `docs/fleet-protocol.md` — fleet token issuance (`/register`), hashed
  storage on the receiver side
- `docs/adoption-patterns/multi-vps-channel-relay.md` — the relay topology
  these tokens protect
- #218 — zero-touch onboarding consumes the init-generated token + secret
  injection contract
