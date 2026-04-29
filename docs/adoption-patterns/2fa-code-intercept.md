# 2FA / OAuth code intercept

*v0.2 — framework-side primitives complete; end-to-end validated on
Nexmatic dashboard adapter (BSBC workspace, 2026-04-29). See "Worked
example — Nexmatic dashboard channel" below for the concrete flow,
gotchas, and observed wall-clock timings.*

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

## Worked example — Nexmatic dashboard channel

End-to-end validation captured 2026-04-29 on the BSBC workspace
(`broken-stick-brewery`, framework `78c6a91`). The skill is a shell
adopter — `_demo/mock-bank-fetch` — that mirrors the shape of any
real bank-CSV-fetch skill but talks to a synthetic mock-bank service.
Source: <https://github.com/Systemsaholic/nexmatic/tree/main/packages/client-dashboard/app/api/mock-bank>.

### Components

| Layer | Component | Where |
|---|---|---|
| Mock service | `POST /api/mock-bank/{login,verify}` returning a 2FA challenge then canned account data | `client-dashboard/app/api/mock-bank/` (Nexmatic) |
| Credential vault | `POST /api/vault/decrypt` (localhost-only, AES-256-GCM) | `client-dashboard/app/api/vault/` (Nexmatic) |
| Skill | `_demo/mock-bank-fetch/run.sh` — shell skill calling the framework HTTP API | `<workspace_root>/nexaas-skills/_demo/mock-bank-fetch/` |
| Channel | Dashboard waitpoint banner (polls `/api/waitpoints`, 6-digit input box, writes inbound drawer on submit) | `client-dashboard/components/waitpoint-banner.tsx` (Nexmatic) |
| Framework primitives | inbound-match-waitpoint, inbound-dispatcher, palace.resolveWaitpoint | `packages/runtime/src/tasks/`, `packages/palace/src/` |

### Flow

```
skill.run                         (t=0)
  ├─ vault.decrypt(mock-bank, password)
  ├─ POST /api/mock-bank/login    → { session_id, requires_2fa: true }
  ├─ POST /api/waitpoints/inbound-match
  │       { match: { room_pattern: "*", content_pattern: "digit_code" },
  │         tags: ["2fa","mock-bank","demo"] }
  │     → { waitpoint_id }
  │     WAL: inbound_match_waitpoint_registered
  ├─ poll palace for resolution drawer keyed by waitpoint_id
  │
  │   ──── human enters code in dashboard banner (t≈19s) ────
  │   POST /api/waitpoints { waitpointId, value: "511100" }
  │   → writes inbox.messaging.dashboard.<sanitized-email> drawer
  │     content = { from: <email>, content: "My code is 511100", … }
  │
  ├─ inbound-dispatcher polls (3s tick)
  │     → matchDrawerAgainstWaitpoints
  │     → palace.resolveWaitpoint(signal, { extracted: "511100", … })
  │     → writes superseding drawer at waitpoints.inbound_match.active
  │       content.resolution.extracted = "511100"
  │     WAL: waitpoint_resolved + inbound_match_waitpoint_resolved
  │
  ├─ poll detects resolution drawer → reads `extracted`
  ├─ POST /api/mock-bank/verify { session_id, code: "511100" }
  │     → { account_data: { … } }
  └─ INSERT _demo.mock-bank.runs.<run_id>  (output drawer)
```

Wall-clock observed: register at `T+0.5s`, resolution WAL ops at `T+19s`
(time spent waiting for the human to type the code), output drawer at
`T+22s`.

### WAL trail (sanitized)

```
inbound_match_waitpoint_registered
  payload: { waitpoint_id, room_pattern: "*", content_pattern: "digit_code",
             timeout_seconds: 300, tags: ["2fa","mock-bank","demo"] }

waitpoint_resolved
  payload: { signal: <waitpoint_id>, drawer_id: <waitpoint_drawer>,
             resolution: { extracted: "511100", drawer_id: <inbound_drawer>,
                            channel_role: "dashboard.<sanitized-email>" } }

inbound_match_waitpoint_resolved
  payload: { waitpoint_id, drawer_id, channel_role,
             extract_mode: "first_regex_match", extracted_length: 6 }
```

### Gotchas surfaced during validation

1. **`room_pattern` is exact-string OR `"*"` — not regex.** The doc's
   "use exact role or `*` for any" line in `RegisterParams` is
   load-bearing; we tried `"inbox.messaging.dashboard\\..*"` first
   and it never matched. Either use the exact `drawer.room` value
   (e.g., `"dashboard.al-nexmatic-ca"`) or `"*"` and rely on
   `content_pattern` + `sender_id` to scope. Adding regex support
   would unblock "any room starting with `dashboard.`" ergonomics
   but is not on the critical path.

2. **Resolution writes a superseding drawer — don't poll the original.**
   `palace.resolveWaitpoint` mutates the original drawer's
   `dormant_signal = NULL` AND inserts a NEW drawer at the same
   `wing/hall/room` whose `content.resolution.extracted` carries the
   value. Poll the new drawer keyed by `waitpoint_id`:

   ```sql
   SELECT content::jsonb->'resolution'->>'extracted'
     FROM nexaas_memory.events
    WHERE workspace = $1 AND wing = 'waitpoints' AND hall = 'inbound_match'
      AND room = 'active'
      AND content::jsonb->'resolution'->>'waitpoint_id' = $2
    ORDER BY created_at DESC LIMIT 1;
   ```

3. **Dashboard middleware blocks worker calls by default.** Skills
   running on the same VPS as the Next.js dashboard need their
   localhost endpoints (`/api/vault/decrypt`,
   `/api/mock-bank/{login,verify}`) excluded from the auth-redirect
   middleware. The route handlers themselves enforce
   localhost + internal-token / shared-secret.

4. **`inbound_dispatches` reports `(none) — no subscriber` when no
   skill subscribes to the channel role.** That's not an error —
   `matchDrawerAgainstWaitpoints` runs in the same dispatcher tick
   regardless, so the waitpoint resolves correctly. Easy to misread
   in journal output during initial debugging.

## Canary status

- **Framework primitive** (#49 + fixes #51 #52): shipped
- **Skill-side tool** (`framework__request_match`): shipped in `d3e2841`
- **Phoenix TD EasyWeb 2FA validation**: pending `td/auth.py` migration
- **Nexmatic dashboard-as-channel adapter (BSBC, 2026-04-29)**: ✅
  validated end-to-end with the worked example above

This doc will be revised again when Phoenix validates the Telegram
adapter against the same primitive (the dashboard validation already
proves the channel-agnostic claim — Telegram is just a different
inbound-drawer source).
