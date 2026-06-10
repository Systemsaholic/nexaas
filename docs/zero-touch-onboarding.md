# Zero-Touch Onboarding — the provisioner contract

*Shipped for #218 (production hardening T6, umbrella #219). The consuming
orchestration (OVH provision → this contract → fleet registration) is
operator-side work: Systemsaholic/nexmatic#11.*

Goal: a script takes a bare Ubuntu VPS to a **validated, heartbeating
workspace** with no human SSH session. The framework's half of that deal is
`nexaas init` being fully non-interactive, idempotent, and ending with a
machine-readable verdict. This document is the contract.

## The sequence

```bash
# 0. Bare VPS: NodeSource node >= 20 (NOT snap — init refuses it),
#    framework clone at the current stable tag (docs/releases.md).

# 1. Secrets arrive via environment (or a pre-written 0600 .env) — never argv.
export NEXAAS_WORKSPACE_ROOT=/home/ubuntu/<workspace>
export DATABASE_URL=postgres://...        # optional — init creates a local DB if absent
export ANTHROPIC_API_KEY=sk-ant-...
export VOYAGE_API_KEY=...                  # optional
export NEXAAS_FLEET_ENDPOINT=https://ops.example/api/fleet   # optional pair —
export NEXAAS_FLEET_TOKEN=flt_...                            # written to .env when both set
export NEXAAS_CROSS_VPS_BEARER_TOKEN=...   # optional — generated per-VPS if absent (#217)
export OPERATOR_NAME="Al" OPERATOR_EMAIL="al@example.com"
export NEXAAS_TIMEZONE=America/Toronto     # workspace_config.timezone (default UTC)

# 2. Deliver the workspace manifest (operator-managed mode), then prove delivery:
mkdir -p "$NEXAAS_WORKSPACE_MANIFEST_DIR"   # default /opt/nexmatic/workspaces
cp <workspace>.workspace.json "$NEXAAS_WORKSPACE_MANIFEST_DIR/"
nexaas validate-manifest <workspace>        # exit 0 valid / 1 invalid / 2 missing

# 3. One command, no TTY:
nexaas init --workspace <workspace> --channel stable < /dev/null
echo "exit=$?"                              # 0 = VALIDATED INSTALL; anything else = halt + alert
```

## What init does (7 steps)

1. **Prerequisites** — node ≥ 20 (refuses snap node), Postgres + pgvector,
   Redis (installs what's missing via apt).
2. **Database** — honors `DATABASE_URL` (env, then a previous `.env`);
   otherwise creates a local DB + role. Migrations run through the **tracked
   runner** (shared with `nexaas upgrade`): applied files are recorded in
   `nexaas_memory.schema_migrations`, so `migration-state` and conformance
   are green from minute one. Inapplicable pre-palace legacy migrations
   (< 012) are recorded-as-resolved with a warning; any 012+ failure aborts
   the install. Also writes the `workspace_config` row (timezone) and
   persists `--channel` to `workspace_kv` so the first `nexaas upgrade`
   already follows it (#214).
3. **Configuration** — `.env` generated at 0600. Existing values survive
   re-runs; process-env values win. Per-VPS bearer token generated when
   absent (#217); fleet endpoint/token written when both are present in the
   environment. Optional `--fleet-endpoint` + `--bootstrap-secret` instead
   performs the `/register` exchange (`docs/fleet-protocol.md`).
4. **Operator bootstrap** — operator row (`OPERATOR_NAME`/`OPERATOR_EMAIL`),
   ed25519 signing key at `~/.nexaas/operator-key.ed25519` (kept if
   present), genesis WAL row (skipped if present).
5. **Service** — npm install + production build + systemd unit
   (`nexaas-worker`), enable + start. systemctl failures are fatal, not
   warnings.
6. **Verification** — connectivity probes (Postgres, pgvector, Redis, WAL,
   `/health`).
7. **Conformance gate** — `nexaas conformance --json` against the live
   install. **Exit 1 from init means the gate failed**: the install exists
   but is NOT validated; the provisioner halts and alerts instead of
   declaring success. Exit-2 gate outcomes (could-not-run) warn but don't
   fail. `--skip-verify` opts out (debugging only).

With fleet env configured, the worker's **first heartbeat fires ~5s after
the service starts** (payload v3 includes the conformance result the gate
just persisted) — the new workspace appears on the ops dashboard before the
provisioning script exits.

## Idempotency guarantees

Re-running init on a half-provisioned VPS converges:

- `.env` values survive (process env > existing `.env` > generated); the
  DB password is **not** rotated when a `DATABASE_URL` already exists —
  re-runs no longer invalidate the previous credentials
- Migrations: tracked runner skips applied files
- Signing key, genesis WAL row, `.mcp.json`, `workspace_config` row: kept
  if present
- systemd unit: rewritten + restarted (safe — same content unless the
  framework changed)

## Inputs reference

| Input | Via | Default |
|---|---|---|
| Workspace id | `--workspace` | prompted (TTY only — required non-interactively) |
| Release channel | `--channel stable\|canary` or `NEXAAS_CHANNEL` | none (legacy tracking-branch) |
| DB connection | `DATABASE_URL` | created locally (`nexaas` DB, whoami role) |
| Model keys | `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` | prompted (TTY) / warn-empty |
| Workspace root | `NEXAAS_WORKSPACE_ROOT` | `NEXAAS_ROOT` |
| Timezone | `NEXAAS_TIMEZONE` | `UTC` |
| Operator | `OPERATOR_NAME`, `OPERATOR_EMAIL` | Al / al@systemsaholic.com |
| Bearer token | `NEXAAS_CROSS_VPS_BEARER_TOKEN` | generated per-VPS |
| Fleet | `NEXAAS_FLEET_ENDPOINT` + `NEXAAS_FLEET_TOKEN`, or `--fleet-endpoint` + `--bootstrap-secret` | unset (no-op) |
| Gate | `--skip-verify` | gate runs |

Every prompt has a non-interactive path: with no TTY, prompts auto-answer
their defaults and empty-default prompts resolve empty (with a warning where
that matters). Run with `< /dev/null` to guarantee no hang.

## Exit codes (the provisioner's contract)

| Code | Meaning | Provisioner action |
|---|---|---|
| 0 | Install complete AND conformance green | record success, expect heartbeat |
| 1 | Hard failure (prereq, migration 012+, build, systemctl, conformance gate) | halt, alert, leave VPS for inspection — re-run converges after the fix |
| 2 | (validate-manifest only) manifest missing | fix delivery, re-run |

## Related

- `docs/security-surface.md` — token + secret-injection discipline (#217)
- `docs/releases.md` — which tag to clone, channel semantics (#214)
- `docs/fleet-protocol.md` — `/register` + heartbeat the new VPS joins (#216)
- `docs/spend-governance.md` — set `spend-budget` right after init (#215)
