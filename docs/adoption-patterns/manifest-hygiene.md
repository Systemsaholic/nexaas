# Manifest hygiene

*v0.1 — distilled from adoption learnings through 2026-04-20. Framework-side
rules; tenant data stays in tenant repos.*

Common workspace-manifest and skill-manifest gotchas, with concrete
examples of what breaks and the fix. Read this before writing or
debugging a manifest.

## Manifest location

The framework reads the workspace manifest from
`NEXAAS_WORKSPACE_MANIFEST_DIR` — defaults to `/opt/nexmatic/workspaces/`
(operator-managed mode).

| Deployment mode | Convention | Env var |
|---|---|---|
| Direct adopter (Phoenix-style) | `/etc/nexaas/workspaces/<id>.workspace.json` | `NEXAAS_WORKSPACE_MANIFEST_DIR=/etc/nexaas/workspaces` in worker systemd env |
| Operator-managed (Nexmatic-style) | `/opt/nexmatic/workspaces/<id>.workspace.json` | unset (default matches) |

Missing manifest is non-fatal — loader fails open, framework runs with
built-in defaults. See [`deployment-patterns.md`](./../deployment-patterns.md)
for the full mode comparison.

## Type-matching — quote string-typed values

**The framework does NOT coerce primitives.** Arguments pass through
`JSON.parse` / `JSON.stringify` untouched. If a tool declares `to: string`
and the manifest supplies a JSON integer, well-behaved MCPs reject with
`isError: true`. Pre-#48 this was silent; post-#48 and post-#50 it's
visible, but it's still preventable.

Wrong:

```json
{
  "channel_bindings": {
    "pa_reply_al": {
      "kind": "telegram",
      "mcp": "telegram-mcp",
      "config": { "chat_id": 1967590134 }
    }
  }
}
```

Right:

```json
{
  "channel_bindings": {
    "pa_reply_al": {
      "kind": "telegram",
      "mcp": "telegram-mcp",
      "config": { "chat_id": "1967590134" }
    }
  }
}
```

Rule of thumb: **if the MCP tool's input schema declares a field as
`string`, quote the value in the manifest** even if it looks numeric.
Applies to chat IDs, phone numbers, account numbers, webhook secrets,
workspace IDs that happen to be all digits.

See `capabilities/_registry.yaml` preamble and issue #50 for the full
framework stance.

## Workspace manifest — required fields

```json
{
  "manifest_version": "0.2",
  "id": "<workspace-id>",
  "name": "<display name>",
  "capability_bindings": { /* abstract capability → concrete MCP */ },
  "channel_bindings": { /* framework role → channel kind + MCP + config */ },
  "installed_agents": [],
  "behavioral_contract": { "approval_posture": "standard" },
  "model_policy": { "default_tier": "good" }
}
```

Canonical schema: `packages/runtime/src/schemas/workspace-manifest.ts`
(Zod). Validator fails open: missing fields get defaults; extra fields
pass through (Nexmatic layer stores `plan`, `addons`, `subdomain`,
etc. this way).

### capability_bindings vs channel_bindings

Easy to conflate; they're different.

- **`capability_bindings`** — abstract capabilities (`messaging-outbound`,
  `email-inbox`, `accounting-system`, `bank-source`) mapped to the MCP
  that implements them. Skills declare they need a capability; framework
  resolves to the bound MCP at invocation time.
- **`channel_bindings`** — human-communication roles (`pa_notify_al`,
  `reviewer_notification`) mapped to a channel kind + MCP + config.
  Skills declare they want to notify/ask a role; framework resolves the
  role to a channel.

A single MCP can fulfill both — e.g., `telegram-mcp` implements the
`messaging-outbound` capability AND is referenced by specific
`channel_bindings` for per-user chat IDs.

Example showing both:

```json
{
  "capability_bindings": {
    "messaging-outbound": { "mcp": "telegram-mcp", "config": {} }
  },
  "channel_bindings": {
    "pa_notify_al":       { "kind": "telegram", "mcp": "telegram-mcp", "config": { "chat_id": "1234" } },
    "pa_notify_mireille": { "kind": "telegram", "mcp": "telegram-mcp", "config": { "chat_id": "5678" } }
  }
}
```

## Skill manifest — output declarations

```yaml
outputs:
  - id: deliver_reply            # must be unique within this skill's outputs[]
    kind: notification           # notification | external_send | palace_write | subagent_invocation | mcp_tool_call
    routing_default: auto_execute  # auto_execute | approval_required | escalate | flag | defer
    notify:
      channel_role: pa_notify_al  # resolves via workspace channel_bindings
    parse_mode: html              # plain | markdown | html (for kind: notification)
    verify:                       # post-run verification (optional)
      type: tool_called
      tool: telegram-mcp__send
      required: true
```

### Things that bite

**1. `kind` missing.** Without `kind`, the engine's auto_execute branch
doesn't know it's a notification. The drawer lands in
`events.skill.executed` and the #40 outbound dispatcher never sees it.
Symptom: AI runs cleanly, WAL shows `action_auto_executed`, phone silent.
(Fixed in #58; always declare `kind` explicitly.)

**2. `channel_role` references a role that isn't in the workspace manifest.**
Framework falls open: writes the notification drawer with
`channel_mcp: null` in metadata, logs `notification_skipped` WAL op
with reason "no channel_binding in workspace manifest". Symptom: WAL
shows the skip, no delivery. Fix: add the role to the workspace manifest's
`channel_bindings`.

**3. `parse_mode` not declared; AI produces rich formatting.**
Default is `plain`, so HTML or markdown renders as literal characters.
Declare `parse_mode: html` (or `markdown`) on the output per issue #61
if the skill produces anything non-plain.

**4. Output `id` with characters that break things.** Stick to
`[a-z_][a-z0-9_]*`. Dots, slashes, and dashes in output ids have surfaced
edge cases with drawer-room naming (issue #54 cosmetic cleanup tracks it).

**5. `primary_output` pointing at an id not in `outputs[]`.** Silent
no-op — skill runs but no TAG routing fires. Framework doesn't validate
the reference today (follow-up worth doing); misspelling the id just
disables the bridge. Double-check ids match exactly.

**6. Approval `handlers` referencing a skill that isn't installed.**
Approval resolves, framework tries to enqueue the handler, fires
`approval_handler_missing` WAL op. Symptom: approval clicks work but no
follow-up skill runs. Fix: install the handler skill manifest at
`nexaas-skills/<category>/<name>/skill.yaml` on the workspace VPS.

## Triggers

```yaml
triggers:
  - type: cron
    schedule: "0 7 * * *"
    timezone: "America/Toronto"   # optional; defaults to workspace_config.timezone or UTC

  - type: inbound-message
    channel_role: pa_reply_al      # adapters write to inbox.messaging.<role>
```

### Things that bite

**1. Cron expression is wrong.** Framework doesn't validate at register
time; BullMQ's scheduler parser throws at runtime if the pattern is
malformed. `nexaas register-skill` surfaces this immediately.

**2. Same skill declares multiple cron triggers.** Framework creates
one scheduler per trigger. If two fire simultaneously, BullMQ runs two
jobs with distinct run_ids. Usually not intended — check if you meant
`schedule: "*/5 * * * *"` (single schedule, every 5 min) instead of
two separate triggers.

**3. `inbound-message` trigger with a channel_role that has no
`channel_bindings` entry.** Skill subscribes but no drawer ever lands
because no adapter writes to that role. Validate the role exists in
workspace manifest before declaring the trigger.

**4. `inbound-message` trigger on a brand-new role.** Drawers written
before the skill was registered won't fire it retroactively — the
inbound-dispatcher records a `(none)` sentinel row for unsubscribed
drawers. To replay: `DELETE FROM inbound_dispatches WHERE skill_id = '(none)'` and let the dispatcher re-evaluate.

## Manifest version

`manifest_version: "0.2"` is current. Older manifests load with warnings
(non-fatal); framework uses compat defaults. New adopters should use
`0.2` or later. Schema migrations bump the number; old manifests get a
`manifest_version_outdated` warning with an upgrade path suggested.

## Environment variables that affect manifest behavior

| Variable | Effect |
|---|---|
| `NEXAAS_WORKSPACE_MANIFEST_DIR` | Where to read `<id>.workspace.json`. Default `/opt/nexmatic/workspaces/`. Direct adopters override. |
| `NEXAAS_WORKSPACE_ROOT` | Where to read `nexaas-skills/**/skill.yaml`. Required for inbound-dispatcher + scheduler self-heal. |
| `NEXAAS_FLEET_ENDPOINT` / `_TOKEN` | Fleet heartbeat for operator-managed mode. Unset = no-op. |
| `NEXAAS_PA_TIMEOUT_MS` | Per-request PA handler timeout. Default 120000 (2 min). |
| `NEXAAS_WAL_RETENTION_DAYS` | Opt-in WAL retention policy. Unset = keep forever. |

## Observation path — what operators see

| Symptom | Query |
|---|---|
| Manifest didn't load? | `SELECT op, payload FROM wal WHERE op = 'manifest_loaded_with_warnings' OR op = 'manifest_load_failed' ORDER BY created_at DESC LIMIT 10;` |
| Dispatch skipped due to missing binding? | `SELECT op, payload FROM wal WHERE op = 'notification_skipped' AND payload::jsonb ->> 'reason' LIKE '%channel_binding%' ORDER BY created_at DESC;` |
| Handler skill missing? | `SELECT op, payload FROM wal WHERE op = 'approval_handler_missing' ORDER BY created_at DESC;` |
| Output kind misconfigured? | `SELECT op, payload FROM wal WHERE op = 'notification_misconfigured' ORDER BY created_at DESC;` |

## Related

- `deployment-patterns.md` — direct adopter vs operator-managed
- `telegram-channel.md` — concrete example of channel_bindings + triggers
- `packages/runtime/src/schemas/workspace-manifest.ts` — canonical Zod schema
- `capabilities/_registry.yaml` — capability interface registry + type-coercion stance

## Tracking

Every gotcha above corresponds to a real incident surfaced during canary
adoption. See issues #50, #51, #52, #58, #61 for the source material.
