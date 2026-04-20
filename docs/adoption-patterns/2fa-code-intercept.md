# 2FA / OAuth code intercept

*v0.1 — framework-side primitives complete; end-to-end validation
pending on first adopter dashboard/SMS/email adapter.*

Pattern for skills that need to pause, prompt a human for a one-time
code (2FA, OAuth redirect parameter, delivery confirmation), and
resume once the human provides it. Channel-agnostic — works for any
channel the workspace has bound (Telegram, dashboard input, email
reply, SMS).

Unblocks flows like:

- TD EasyWeb / RBC / Scotiabank 2FA during daily CSV sync
- OAuth redirect URL capture (Google, Salesforce, LinkedIn, …)
- Stripe / Plaid / QuickBooks verification codes
- Any human-in-the-loop code relay

Surfaced concretely by Phoenix's TD migration (#49) and Nexmatic's
credential-vault-gated bank-login flow (#59). The primitive is the
same for both; the channel and the credential storage vary by adopter.

## When to use this pattern

- A skill authenticates to an external service mid-run
- The service sends a code to the human (SMS, email, authenticator app,
  OAuth redirect)
- The skill needs that code to complete the request

## When **not** to use

- You already have the code in a credential vault (use it directly, no
  intercept needed)
- The service supports an API key or service-account auth (prefer those
  over 2FA relay)
- The "code" is actually a long-lived token — store it, don't re-request

## Two surfaces — pick the right one

### Surface 1: HTTP API — non-skill callers

For scripts, shell tools, and external CLIs running on the workspace
VPS. Uses `POST /api/waitpoints/inbound-match` directly.

```python
import requests, time

r = requests.post("http://localhost:9090/api/waitpoints/inbound-match", json={
    "workspace": "<workspace-id>",
    "match": {
        "room_pattern": "<channel_role>",       # e.g., pa_reply_al
        "content_pattern": "digit_code",
        "sender_id": "<sender_id>",             # scope for safety
    },
    "timeout_seconds": 300,
    "extract": "first_regex_match",
})
wp = r.json()
poll_url = f"http://localhost:9090{wp['poll_url']}?workspace=<workspace-id>"

# Tell the human to enter the code (via any means — direct Telegram send,
# stdout prompt, web UI, whatever the script owns).

while True:
    status = requests.get(poll_url).json()
    if status["status"] == "resolved":
        code = status["resolved_with"]["content"]
        break
    if status["status"] in ("expired", "cancelled"):
        raise TimeoutError(status)
    time.sleep(2)

# Use code to complete the login flow
```

### Surface 2: `framework__request_match` tool — ai-skills

For ai-skill-type skills. Inject-and-forget; the tool is in every
agentic loop's toolset.

Skill prompt:

```
When the login page asks for a 2FA code, call
framework__request_match with channel_role: "<role>" and
content_pattern: "digit_code". Block on the return. When resolved,
feed the content as the 2FA code to the login tool.
```

Tool signature:

```
framework__request_match({
  channel_role: "<role>",
  content_pattern: "digit_code",         // or hex_token | url | uuid_v4 | any
  content_regex: "...",                  // with raw: true for custom patterns
  raw: false,
  sender_id: "<id>",                     // security-scoped to expected sender
  timeout_seconds: 300,
  extract: "first_regex_match",
  tags: ["2fa", "bank"]                  // optional — see "UI rendering hints" below
})
```

Returns on match:

```json
{ "ok": true, "status": "resolved", "content": "123456",
  "drawer_id": "<uuid>", "matched_at": "<ISO>",
  "waitpoint_id": "wp_..." }
```

Returns on failure:

```json
{ "ok": false, "status": "timeout" | "cancelled" | "expired",
  "error": "...", "waitpoint_id": "..." }
```

## Required framework primitives

| Primitive | File | Role |
|---|---|---|
| Inbound-match waitpoint | `packages/runtime/src/tasks/inbound-match-waitpoint.ts` | Core pattern-matched waitpoint + HTTP API |
| `framework__request_match` | `packages/runtime/src/ai-skill-framework-tools.ts` | Skill-side wrapper with polling + cancel-on-timeout |
| Inbound dispatcher | `packages/runtime/src/tasks/inbound-dispatcher.ts` | Fires waitpoint resolution on drawer arrival |
| Workspace manifest loader | `packages/runtime/src/schemas/load-manifest.ts` | Resolves channel_role → bound channel |

## Required channel adapter (workspace-owned)

The channel that delivers the code-entry UI to the human needs to:

1. Expose an input mechanism (Telegram reply, dashboard input box, email
   reply, SMS)
2. On submit, write a drawer to `inbox.messaging.<role>` with the v0.2
   canonical shape:

   ```json
   {
     "id": "<adapter-native-id>",
     "from": { "id": "<user-id>", "name": "?" },
     "content": "123456",
     "timestamp": "<ISO>"
   }
   ```

3. That's it. The inbound-dispatcher + inbound-match waitpoint do the
   rest.

## Security: always scope by `sender_id`

A waitpoint registered for `channel_role: pa_reply_al` with no
`sender_id` will resolve on the next drawer landing in that role —
including drawers from other users if the adapter routes multiple
senders through the same role.

For 2FA specifically, **always pass `sender_id`** to scope the waitpoint
to the expected human. Without it, an attacker with adapter write
access could resolve your waitpoint with an arbitrary code.

Framework doesn't enforce this (some patterns are legitimately
sender-agnostic — e.g., a shared admin channel), but skill prompts
should consistently require it for credential-adjacent flows.

## UI rendering hints — the `tags` array

Waitpoint registrations accept an optional `tags: string[]` field. The
framework ignores them entirely — they're pure passthrough metadata stored
in the waitpoint's state JSON. Dashboards and UIs read them to render
subtype-specific affordances.

Examples:

- `["2fa"]` — dashboard renders a styled "Enter the code your bank sent" input
- `["oauth", "google"]` — dashboard shows a Google-branded redirect-URL box
- `["delivery-confirmation"]` — simple yes/no prompt
- `[]` or unset — generic reply box

Read from the dashboard side with:

```sql
SELECT id, content::jsonb -> 'tags' AS tags
  FROM nexaas_memory.events
 WHERE wing='waitpoints' AND hall='inbound_match' AND room='active'
   AND dormant_signal IS NOT NULL;
```

The framework has zero semantics here — a workspace adopter can pick any
tag convention. Tags are capped at 16 per waitpoint and non-string values
are dropped at registration.

## Timeout policy

Named-pattern defaults:

- `digit_code` — 5 min default (2FA codes usually expire fast)
- `hex_token` — 5 min default (OAuth callback tokens similar)
- `url` — no default; declare per-skill
- `any` — no default; declare per-skill

Always declare `timeout_seconds` explicitly for credential flows. Good
range: 180-600s. Shorter than the channel's own message delivery lag
risks false timeouts; longer than the external service's code validity
window wastes resources.

## Observation path

| Stage | WAL op | SQL |
|---|---|---|
| Waitpoint registered | `inbound_match_waitpoint_registered` | `SELECT * FROM wal WHERE op = 'inbound_match_waitpoint_registered' ORDER BY created_at DESC LIMIT 10;` |
| Human submits code via channel | (drawer write — no WAL op) | `SELECT * FROM events WHERE wing='inbox' AND hall='messaging' AND content::jsonb ->> 'content' ~ '^[0-9]{4,8}$' ORDER BY created_at DESC LIMIT 10;` |
| Waitpoint resolves | `inbound_match_waitpoint_resolved` | `SELECT * FROM wal WHERE op = 'inbound_match_waitpoint_resolved' ORDER BY created_at DESC LIMIT 10;` |
| Timeout (no match) | *(waitpoint-reaper cancels)* | `SELECT * FROM events WHERE wing='waitpoints' AND hall='inbound_match' AND dormant_signal IS NULL AND content::jsonb ->> 'cancelled' IS NULL ORDER BY created_at DESC;` |
| Cross-drawer race (rare) | `inbound_match_resolve_failed` | `SELECT * FROM wal WHERE op = 'inbound_match_resolve_failed' ORDER BY created_at DESC LIMIT 10;` |

## Deployment-mode considerations

### Direct adopter (Phoenix)

All waitpoints are localhost-to-localhost. No external exposure. Script
calls `localhost:9090/api/waitpoints/inbound-match`; framework polls
inbox drawers; Telegram adapter (or whatever channel) delivers the
code. No cross-VPS concerns.

### Operator-managed (Nexmatic)

Same primitive, but the channel that relays the code is typically
the operator's dashboard. Nexmatic writes a dashboard adapter that:

1. Receives user input via the dashboard's own web form
2. Writes `inbox.messaging.<role>` drawer on the client VPS
3. Inbound-match waitpoint resolves the same way

The dashboard adapter is Nexmatic-side (build under
`/opt/nexmatic/packages/`); the framework primitive is the same.

For multi-VPS scenarios where the dashboard runs centrally and the
client VPS receives codes, the dashboard adapter SSH's or API-calls
into the client VPS to write the inbox drawer. See the waitpoint API
auth follow-up (#53) for bearer-token scenarios.

## Known limits

- **First-match-wins.** If multiple waitpoints match the same inbound
  drawer, only the first resolves. Intentional for code-intercept (one
  call, one code); not suitable for broadcast scenarios.
- **No streaming.** One match per registration. Need a second code? Call
  again.
- **Raw regex safety check** rejects catastrophic-backtracking patterns.
  Stick to named patterns unless the pattern really is novel — named
  patterns are faster, safer, and standardized.

## Rollback

- **Stop new registrations:** revert the skill or script.
- **Clear pending waitpoints:** `DELETE FROM events WHERE wing='waitpoints' AND hall='inbound_match' AND dormant_signal IS NOT NULL;` — they'll just
  time out naturally anyway.
- **Full rollback of the primitive:** `git revert 731557e`. HTTP API and
  tool both go away. Legacy skill paths revert to whatever workaround
  existed before.

## Canary status

- **Framework primitive** (#49 + fixes #51 #52): shipped
- **Skill-side tool** (`framework__request_match`): shipped in `d3e2841`
- **Phoenix TD EasyWeb 2FA validation**: pending `td/auth.py` migration
- **Nexmatic dashboard-as-channel adapter**: pending Nexmatic-side work

This doc will be revised when Phoenix validates end-to-end and when
Nexmatic's first 2FA-gated skill lands.
