# Debugging playbook

*v0.1 — distilled from framework-side canary diagnostics through 2026-04-20.*

Symptom → diagnosis → fix, indexed by what the operator sees. Every
section says what to query and where to look next. No tenant data,
no workspace IDs — adapt the queries to your own `$1` binding.

## Prerequisites — what the framework writes

Three tables + a structured log carry most diagnostics:

| Table | Owns | Query pivot |
|---|---|---|
| `nexaas_memory.skill_runs` | One row per skill invocation, status, token use, last activity | `run_id`, `workspace`, `started_at DESC` |
| `nexaas_memory.events` | Every drawer written by every skill/framework task. Waitpoint state lives here as `dormant_signal IS NOT NULL` | `workspace`, `wing`, `hall`, `room`, `created_at` |
| `nexaas_memory.wal` | Append-only audit trail of framework operations | `op`, `actor`, `payload->>…` |
| `nexaas_memory.inbound_dispatches` | One row per (drawer, skill) dispatch pair — dedup guarantee | `drawer_id`, `skill_id`, `dispatched_at` |
| `nexaas_memory.notification_dispatches` | Outbound delivery idempotency + native message IDs | `idempotency_key`, `status`, `claimed_at` |

Plus the live runtime:

- **`http://<vps>:9090/health`** — worker status, uptime, state
- **`http://<vps>:9090/queues`** — Bull Board dashboard (BullMQ jobs)
- **`journalctl -u nexaas-worker.service`** — but note snap-node stdout
  is often invisible here; prefer `nexaas status` for ground truth

## Symptom index

| You see | Jump to |
|---|---|
| Sent a message, nothing happened | [§1 Inbound didn't fire a skill](#1-inbound-didnt-fire-a-skill) |
| Skill started then vanished | [§2 Skill failed mid-flight](#2-skill-failed-mid-flight) |
| Skill stuck running for hours | [§3 Skill hung](#3-skill-hung) |
| Approval button pressed, skill didn't resume | [§4 Approval didn't resume](#4-approval-didnt-resume) |
| `framework__request_match` timed out | [§5 Inbound-match waitpoint didn't match](#5-inbound-match-waitpoint-didnt-match) |
| Cross-VPS relay: drawer never arrived | [§6 Cross-VPS relay failure](#6-cross-vps-relay-failure) |
| Prompt caching not reducing cost | [§7 Prompt caching not engaging](#7-prompt-caching-not-engaging) |
| MCP tool errors / missing tools | [§8 MCP trouble](#8-mcp-trouble) |
| Token costs spiking unexpectedly | [§9 Cost spike](#9-cost-spike) |
| Worker keeps restarting | [§10 Worker crash loop](#10-worker-crash-loop) |

---

## §1 Inbound didn't fire a skill

Work the pipeline backward: did the skill run? Did the dispatcher
see the drawer? Did the drawer land at all?

### Step 1 — did a skill run fire?

```sql
SELECT run_id, skill_id, status, started_at, error_summary
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1
   AND started_at > now() - interval '10 minutes'
 ORDER BY started_at DESC LIMIT 10;
```

If the skill you expected is absent: dispatcher didn't fire it. Go to Step 2.

### Step 2 — did the dispatcher see the drawer?

```sql
SELECT drawer_id, skill_id, status, dispatched_at, error
  FROM nexaas_memory.inbound_dispatches
 WHERE workspace = $1
   AND dispatched_at > now() - interval '10 minutes'
 ORDER BY dispatched_at DESC LIMIT 10;
```

- **Row present, `status='dispatched'`, no skill run in §1** → BullMQ
  enqueue succeeded but worker crashed before picking it up. Check
  `/queues` dashboard and worker logs.
- **Row present, `status='failed'`** → dispatcher caught an error.
  Read `error` column.
- **No row** → dispatcher didn't see the drawer or didn't match it
  to a subscribed skill. Go to Step 3.

### Step 3 — did the drawer land?

```sql
SELECT id, wing, hall, room, left(content, 200) AS preview, created_at
  FROM nexaas_memory.events
 WHERE workspace = $1
   AND wing = 'inbox' AND hall = 'messaging'
   AND created_at > now() - interval '10 minutes'
 ORDER BY created_at DESC LIMIT 10;
```

- **Drawer present** → dispatcher saw it but no skill is subscribed
  to that `room` (which is the `channel_role`). Check the skill
  manifest's `triggers: [{ type: inbound-message, channel_role: ... }]`
  matches the `room` exactly.
- **No drawer** → inbound never landed. Work the adapter backward:
  webhook reached? writeDrawer called?

### Common causes

| Cause | Fix |
|---|---|
| `channel_role` mismatch between adapter and skill manifest | Align them; role strings are compared literally |
| Adapter wrote drawer but framework skill registry cache is stale (30s TTL) | Wait 30s or restart worker |
| Skill manifest has a YAML indent error that makes the `triggers` section invisible | Run `nexaas dry-run <skill.yaml>` |
| Multiple skills subscribed — one fired, the other silently matched `inbound_no_subscriber` sentinel | Check WAL: `SELECT op, payload FROM nexaas_memory.wal WHERE op='inbound_no_subscriber'` |

---

## §2 Skill failed mid-flight

### Find the error

```sql
SELECT run_id, skill_id, status, error_summary, started_at, completed_at
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1 AND status = 'failed'
   AND started_at > now() - interval '1 hour'
 ORDER BY started_at DESC LIMIT 10;
```

### Get the full context

```sql
-- All WAL ops for this run
SELECT op, actor, payload, created_at
  FROM nexaas_memory.wal
 WHERE workspace = $1 AND (payload ->> 'run_id') = $2
 ORDER BY created_at ASC;

-- All drawers written by this run
SELECT wing, hall, room, left(content, 300) AS preview, created_at
  FROM nexaas_memory.events
 WHERE workspace = $1 AND run_id = $2::uuid
 ORDER BY created_at ASC;
```

Read the WAL chronologically. The last few ops before the failure
usually tell the story — a `model_call` followed by an `agentic_aborted`
(`payload->>'reason'` = error class), an MCP `tool_call` with an
`isError: true` result, etc.

### Common error classes

| `error_summary` starts with | Likely cause |
|---|---|
| `MCP tool error:` | MCP subprocess returned `isError: true`. Check that tool's input shape — often a string/int type mismatch (see [`manifest-hygiene.md`](./manifest-hygiene.md)) |
| `Anthropic API error:` | Rate limit, context overflow, or model quota. Check `NEXAAS_PROMPT_CACHE=on` + `model_tier` |
| `pa handler timed out after Ns` | `NEXAAS_PA_TIMEOUT_MS` exceeded. Either the model is slow or an MCP is wedged. Increase timeout or investigate the stuck tool call |
| `Cannot find a tsconfig.json` | Packaging issue — shouldn't happen in prod. See #37 |
| `BullMQ jobId separator:` | Library upgrade issue, fixed in #46 (`3a5ef6d`). Pull latest |

---

## §3 Skill hung

Stuck runs show `status='running'` with a stale `last_activity`.

```sql
SELECT run_id, skill_id, current_step,
       age(now(), last_activity) AS since_activity
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1 AND status = 'running'
   AND last_activity < now() - interval '10 minutes'
 ORDER BY started_at ASC;
```

### What "hung" actually means

1. **Waiting on an approval** — `current_step` mentions approval;
   `last_activity` is the approval-request write time. **This is
   normal** until the approver responds or the timeout fires.
2. **Waiting on an inbound-match waitpoint** — check:
   ```sql
   SELECT id, dormant_signal, dormant_until
     FROM nexaas_memory.events
    WHERE workspace = $1
      AND wing = 'waitpoints' AND hall = 'inbound_match'
      AND room = 'active'
      AND content::jsonb ->> 'parent_run_id' = $2;
   ```
   Also normal until match, timeout, or manual cancel via `DELETE /api/waitpoints/:id`.
3. **Actually wedged** — no approval, no waitpoint, `current_step`
   points at a model call or tool call. The worker is probably stuck
   in an HTTP request. Check `/queues` — if the job is "active" for
   >10 min, restart the worker: `sudo systemctl restart nexaas-worker.service`.
   The framework reconciles stale `running` rows on startup
   (`worker.ts:134`).

### Mark a hung run as failed (last resort)

```sql
UPDATE nexaas_memory.skill_runs
   SET status = 'failed',
       error_summary = 'manually terminated — stuck',
       completed_at = now()
 WHERE run_id = $1;
```

Only do this after confirming there's no in-flight BullMQ job. The
reaper and dispatcher read this column; flipping it to `failed` stops
any state-machine assumption that the run is progressing.

---

## §4 Approval didn't resume

### Confirm the button click landed

```sql
SELECT id, room, left(content, 400) AS preview, created_at
  FROM nexaas_memory.events
 WHERE workspace = $1
   AND wing = 'inbox' AND hall = 'messaging'
   AND content::jsonb ? 'action_button_click'
   AND created_at > now() - interval '15 minutes'
 ORDER BY created_at DESC;
```

No row → the adapter never wrote the click-as-drawer. Adapter bug.

### Confirm the approval resolver picked it up

```sql
SELECT op, payload, created_at
  FROM nexaas_memory.wal
 WHERE workspace = $1
   AND op IN ('approval_granted', 'approval_denied', 'approval_resolved',
              'waitpoint_resolved')
   AND created_at > now() - interval '15 minutes'
 ORDER BY created_at DESC;
```

No row → approval resolver isn't running, or the `button_id` doesn't
match the expected `approval:<run_id>:...:approve|reject` prefix.
Check the adapter's button-id encoding.

### Confirm the skill actually resumed

Check `skill_runs.status` for the run. Post-approval resumption
(handler skill pattern) lands in `f73cb8f`; if your flow depends on
conditional logic after approval, make sure the manifest has
`outputs[].approval.on_resolve` pointing at a handler skill.

---

## §5 Inbound-match waitpoint didn't match

### Is the waitpoint still active?

```sql
SELECT id,
       dormant_signal,
       dormant_until,
       content::jsonb AS state
  FROM nexaas_memory.events
 WHERE workspace = $1
   AND wing = 'waitpoints' AND hall = 'inbound_match' AND room = 'active'
   AND dormant_signal IS NOT NULL
 ORDER BY created_at DESC LIMIT 20;
```

- **Empty result** → waitpoint expired, was cancelled, or already resolved.
  Check WAL:
  ```sql
  SELECT op, payload FROM nexaas_memory.wal
   WHERE op IN ('inbound_match_waitpoint_resolved',
                'inbound_match_waitpoint_expired',
                'inbound_match_waitpoint_cancelled')
     AND workspace = $1 ORDER BY created_at DESC LIMIT 10;
  ```
- **Row present with `dormant_until < now()`** → expired but reaper
  hasn't swept yet. Will clear on the next reaper tick.

### Did the target drawer arrive?

```sql
SELECT id, room, left(content, 300) AS preview, created_at
  FROM nexaas_memory.events
 WHERE workspace = $1
   AND wing = 'inbox' AND hall = 'messaging'
   AND created_at > <waitpoint_created_at>
 ORDER BY created_at ASC;
```

For each candidate drawer, check:
- **Content pattern matches?** Named patterns: `digit_code`, `hex_token`,
  `url`, `uuid_v4`, `any`. Custom regex via `match.regex`.
- **Sender scope matches?** If the waitpoint was registered with
  `match.sender_id`, the drawer's `from` field must match.
- **Channel role matches?** Waitpoint's `match.channel_role` must
  equal the drawer's `room`.

### Test a pattern

```bash
curl -s http://localhost:9090/api/waitpoints/inbound-match/patterns | jq
```

### Manual resolve (for testing)

```bash
# Register a test waitpoint, then inject a matching drawer via /api/drawers/inbound:
curl -s -X POST http://localhost:9090/api/drawers/inbound \
  -H "Authorization: Bearer $NEXAAS_CROSS_VPS_BEARER_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "workspace": "your-workspace",
    "channel_role": "pa_reply_test",
    "message": {
      "id": "test-1",
      "from": "tester",
      "content": "your code is 123456",
      "timestamp": "2026-04-20T12:00:00Z"
    }
  }'
```

---

## §6 Cross-VPS relay failure

For operator-managed mode (see
[`multi-vps-channel-relay.md`](./multi-vps-channel-relay.md)).

### Did the POST reach the client VPS?

Client-side WAL check:

```sql
SELECT actor, payload, created_at
  FROM nexaas_memory.wal
 WHERE workspace = $1 AND op = 'inbound_drawer_relayed'
   AND created_at > now() - interval '15 minutes'
 ORDER BY created_at DESC;
```

- **No row** → request didn't reach the VPS, or hit before landing
  in the palace. Check:
  - Relay-side: look for the response code from the `fetch()` call.
    `401` → bearer token mismatch. `400` → payload validation
    failed (see below). `5xx` → palace write error, check worker logs.
  - Network: can the relay VPS reach the client VPS on port 9090?

### 400 validation failures

Framework validates:
- `workspace`: non-empty string
- `channel_role`: non-empty string
- `message`: object (not array) with at least one of `content`,
  `attachments`, `action_button_click`

Relay bug: most often `channel_role` is computed wrong (e.g.,
lookup in routing table returned `undefined` and got coerced).

### 401 bearer mismatch

Both sides must have the same `NEXAAS_CROSS_VPS_BEARER_TOKEN`:

```bash
# Client VPS
grep NEXAAS_CROSS_VPS_BEARER_TOKEN /opt/nexaas/.env

# Relay VPS — wherever your relay reads its token from
```

Token comparison is `crypto.timingSafeEqual` — whitespace and
trailing newlines count. Use `echo -n` when exporting.

### Drawer landed but skill didn't fire

Go to [§1](#1-inbound-didnt-fire-a-skill). Past the relay, the
flow is identical to single-VPS inbound.

---

## §7 Prompt caching not engaging

### Sanity-check env

```bash
grep NEXAAS_PROMPT_CACHE /opt/nexaas/.env
# unset or "on"/"true"/"1" → caching active
# "off"/"false"/"0"        → disabled
```

### Did the call actually write cache?

```sql
SELECT run_id,
       token_usage ->> 'input_tokens'               AS input,
       token_usage ->> 'cache_creation_input_tokens' AS created,
       token_usage ->> 'cache_read_input_tokens'     AS read,
       token_usage ->> 'cost_usd'                    AS cost
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1
   AND completed_at > now() - interval '1 hour'
 ORDER BY completed_at DESC LIMIT 10;
```

Expected patterns:

| Scenario | input | cache_creation | cache_read | cost |
|---|---|---|---|---|
| First run of skill | ~40-100k | >= 1024 | 0 | Normal |
| Second run within 5 min | ~40-100k | ~0 | >= 1024 | **60-80% lower** |
| Prefix too short (< 1024 tokens) | ~40-100k | 0 | 0 | Normal |
| 5-min TTL expired | ~40-100k | >= 1024 | 0 | Normal |

### Gotchas

- **Prefix < 1024 tokens = silent no-op.** Anthropic ignores
  `cache_control` below threshold. You'll see `cache_creation = 0`
  permanently. This is expected for small-prompt skills — no fix
  needed, caching only matters above the threshold.
- **System prompt varies per turn** → no cache hit. If you interpolate
  a timestamp or run_id into the system prompt, the prefix changes
  every call. Move the variable content into the user message.
- **Tool list varies.** If MCP discovery returns a different tool set
  across runs (servers coming online late), the last-tool
  `cache_control` anchor shifts and the cache misses. Stabilize MCP
  availability via the `NEXAAS_MCP_SERVERS` explicit list if needed.

---

## §8 MCP trouble

### Is the MCP connected?

```bash
# See which MCPs the worker booted successfully
journalctl -u nexaas-worker.service -n 200 | grep -i 'mcp'
```

Cold-spawn is ~500ms; warm tool calls are 50-200ms. If a tool call
is hanging for seconds: the MCP subprocess is stuck. Restart the
worker to force a clean spawn.

### Is the tool actually registered?

At runtime, `mcpClient.getTools()` returns the discovered tools. If
your skill manifest references `server__tool` but the worker logs
say `MCP not connected: server`, the MCP config is missing or the
connect failed.

Check `NEXAAS_WORKSPACE_ROOT/.mcp.json` or equivalent stdio config.

### Tool returned `isError: true`

Post-[#48](https://github.com/Systemsaholic/nexaas/issues/48), the
framework throws on `isError: true` rather than silently returning.
The thrown error reaches the agentic loop and ends up in `error_summary`.

Common `isError` causes:
- **Type mismatch** — tool expects `string`, caller passed `number`.
  Python/Pydantic MCPs are strict. See [`manifest-hygiene.md`](./manifest-hygiene.md).
- **Missing auth** — API key env var not set in MCP's launch env.
- **External service error** — propagated from the MCP's downstream call.

---

## §9 Cost spike

### Is caching regressing?

```sql
SELECT date_trunc('hour', completed_at) AS h,
       count(*) AS runs,
       avg((token_usage->>'input_tokens')::int) AS avg_input,
       avg((token_usage->>'cache_read_input_tokens')::int) AS avg_cache_read,
       sum((token_usage->>'cost_usd')::numeric) AS hourly_cost
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1
   AND completed_at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 1 DESC;
```

Sudden drop in `avg_cache_read` without an obvious cause (model
change, prompt rewrite) suggests the cache key moved. See [§7 gotchas](#gotchas).

### Is a specific skill / model driving the cost?

```sql
SELECT skill_id,
       count(*) AS runs,
       sum((token_usage->>'cost_usd')::numeric) AS total,
       round(avg((token_usage->>'cost_usd')::numeric)::numeric, 4) AS avg_cost
  FROM nexaas_memory.skill_runs
 WHERE workspace = $1
   AND completed_at > now() - interval '24 hours'
 GROUP BY skill_id ORDER BY total DESC LIMIT 10;
```

### Is a loop running away?

```sql
-- Runs that hit the max-turn ceiling (agentic loop exhaustion)
SELECT op, payload FROM nexaas_memory.wal
 WHERE op = 'agentic_aborted' AND payload->>'reason' = 'max_turns'
   AND created_at > now() - interval '24 hours'
 ORDER BY created_at DESC LIMIT 20;
```

A runaway skill hitting `max_turns` burns full-rate tokens. Check
the prompt for an infinite-retry pattern or a missing stop condition.

---

## §10 Worker crash loop

### First look — systemd

```bash
sudo systemctl status nexaas-worker.service
journalctl -u nexaas-worker.service -n 100 --no-pager
```

### The WAL records crashes

```sql
SELECT actor, payload, created_at
  FROM nexaas_memory.wal
 WHERE op = 'worker_crashed'
   AND created_at > now() - interval '1 hour'
 ORDER BY created_at DESC;
```

`payload` contains `origin` (uncaughtException / unhandledRejection)
+ `error` + `stack` (truncated). Only `uncaughtException` triggers a
restart; `unhandledRejection` logs and keeps running.

### Common crash causes

| Symptom | Cause | Fix |
|---|---|---|
| Port already in use on restart | Orphan child still holding 9090 | `systemd` unit uses `KillMode=mixed` + `ExecStopPost=fuser -k 9090/tcp` — verify your systemd unit has these |
| `snap-node` stdout invisible in `journalctl` | Snap isolation | Run `nexaas status` for structured state; see [`project_snap_journald`](../../.claude/projects/-opt-nexaas/memory/project_snap_journald.md) |
| `NEXAAS_WORKSPACE is required` | Env not loaded by systemd | `EnvironmentFile=/opt/nexaas/.env` in unit |
| pg idle disconnect | Fixed in `b6da9b8` (keepalive) + `#34` (error handler) | Pull latest |
| BullMQ repeatable lock conflict | Stale job from previous run | Worker reconciles on startup — single restart should clear it |

---

## Health scripts

### Framework-provided

```bash
# One-line summary (safe to run anywhere)
nexaas status

# 10-point detailed health report
nexaas health

# WAL chain integrity (expensive — run before backups)
nexaas verify-wal --full
```

### Ad-hoc

```bash
# Queue state
curl -s http://localhost:9090/queues/api/queues | jq '.queues[] | {name, counts}'

# Active waitpoints
curl -s "http://localhost:9090/api/waitpoints/inbound-match/patterns" \
  -H "Authorization: Bearer $NEXAAS_CROSS_VPS_BEARER_TOKEN"

# Recent skill runs
psql "$DATABASE_URL" -c "SELECT skill_id, status, started_at FROM nexaas_memory.skill_runs ORDER BY started_at DESC LIMIT 20;"
```

## When to escalate to framework team

File a new issue on `Systemsaholic/nexaas` when:

- A WAL op exists but its payload is missing context you'd need to
  debug (under-instrumented codepath)
- A symptom reproduces but none of the queries above surface it
  (gap in observability primitives)
- A fix is available but requires a framework change (Phoenix /
  Nexmatic should not patch framework code — file + cite)

Include in the issue: the workspace (direct-adopter / operator-managed),
the symptom, the queries you ran, the WAL op trail, and — critically —
what the docs here said to do that didn't work. Docs-gap reports
tighten this playbook.

## Related

- [`manifest-hygiene.md`](./manifest-hygiene.md) — catch 80% of
  config bugs before they become runtime bugs
- [`telegram-channel.md`](./telegram-channel.md) — single-VPS
  observation paths
- [`multi-vps-channel-relay.md`](./multi-vps-channel-relay.md) —
  operator-mode observation paths
- [`2fa-code-intercept.md`](./2fa-code-intercept.md) — inbound-match
  waitpoint semantics, named patterns
