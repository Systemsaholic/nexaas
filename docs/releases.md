# Release Process

How Nexaas framework releases are cut, promoted through channels, hotfixed,
and rolled back. Mechanics live in `packages/cli/src/upgrade.ts` (#214);
this doc is the operator-facing procedure.

> **Core rule: `main` is never deployed to clients.** Client VPSes consume
> annotated semver tags via release channels. `main` is where development
> integrates; a release is a deliberate, tagged, changelog'd cut from it.
> Legacy deployments with no channel configured (the pre-#214 fleet) keep
> tracking their branch until an operator opts them in with
> `nexaas upgrade --channel stable`.

## The pieces

| Piece | What it is |
|---|---|
| Release | Annotated git tag `vX.Y.Z` on the origin repo + a `CHANGELOG.md` section |
| `channel/canary` | Git branch in origin, fast-forwarded by ops to the tag under soak |
| `channel/stable` | Git branch in origin, fast-forwarded to the last tag that survived soak |
| Workspace channel | `workspace_kv` key `framework_channel` (`stable` or `canary`), set via `nexaas upgrade --channel <name>` |
| Previous ref | `workspace_kv` key `framework_previous_ref` — recorded before every HEAD move; the rollback target |
| Version history | `nexaas_memory.framework_versions` — one row per install/rollback on each workspace |

A workspace on a channel upgrades to wherever its channel branch points —
which is always a tagged release commit, because ops only ever fast-forwards
channel branches to tags. Canary tags are invisible to stable workspaces
until the stable pointer advances.

## Cutting a release

1. **Version stamp**: set the root `VERSION` file to `X.Y.Z` (no `v` prefix).
   The fleet heartbeat and `skill_runs.framework_version` stamping read this
   file — tagging without bumping it ships a release that self-reports the
   previous version (v0.3.0 shipped reporting `0.2.0`; learned the hard way).
2. **Changelog**: move the `## Unreleased` content in `CHANGELOG.md` into a
   new `## vX.Y.Z — YYYY-MM-DD` section. Semver intent: patch = fixes only,
   minor = additive features/migrations, major = breaking (avoid; requires a
   coordinated fleet plan).
3. **Migration notes**: the release section MUST list every
   `database/migrations/` file the release introduces, with a one-line note
   per migration confirming it is one-release backward compatible (see
   [Rollback](#rollback) for what that means). A migration that cannot meet
   the rule does not ship — split it into a two-phase removal instead.
4. **Tag** (annotated, on the release commit):

   ```bash
   git tag -a vX.Y.Z -m "Nexaas vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. **Point canary at it**:

   ```bash
   git push origin vX.Y.Z^{commit}:refs/heads/channel/canary
   ```

No CI infrastructure required — the release gate is `nexaas conformance`
running on every upgrading workspace, not a central pipeline.

## Canary cohort promotion

A release soaks through the cohort before stable advances:

1. **Testlab VPS** — `nexaas upgrade` (workspace already on `canary`).
   Conformance gate must pass; let it run the workload for a day.
2. **Phoenix** — same. Phoenix is the live direct-adopter canary; watch
   `ops.*` escalations and the fleet heartbeat for a soak period sized to
   the change (hours for a patch, days for a minor).
3. **One volunteer client** — operator-managed, with consent. Same watch.
4. **Promote to stable** once the cohort is clean:

   ```bash
   git push origin vX.Y.Z^{commit}:refs/heads/channel/stable
   ```

Stable workspaces pick the release up on their next `nexaas upgrade`. If any
cohort stage fails: `nexaas upgrade --rollback` on the affected workspace,
fix forward on `main`, cut the next tag, restart the soak. Channel branches
only ever move forward — a bad canary tag is superseded, not unpublished.

## Hotfix push

Per the locked decision (#219): no remote-command endpoint. The push path is
ops running the CLI over retained root SSH:

```bash
ssh root@client-vps
nexaas upgrade --to vX.Y.Z        # pin directly to the hotfix tag
```

`--to` works with or without a channel configured and leaves the workspace's
channel setting untouched — the next plain `nexaas upgrade` returns to
following the channel pointer. Tag the hotfix and fast-forward the channels
afterwards so the fleet converges on it instead of stepping back over it.

The conformance gate runs after a `--to` upgrade like any other; use
`--no-verify` only when the outage you are fixing is what makes conformance
fail.

## Post-upgrade conformance gate

Every upgrade that moves HEAD ends with `nexaas conformance --json` after the
worker restart + health check:

- **Pass (exit 0)** — upgrade recorded (`framework_upgraded` WAL op +
  `framework_versions` row).
- **Fail (exit 1)** — automatic rollback to the recorded previous ref, WAL
  op `upgrade_conformance_failed`, command exits 1. The bad release never
  stays running.
- **Cannot run (exit 2)** — warn and keep the upgrade; run `nexaas
  conformance` manually.

`--no-verify` skips the gate. Emergencies only.

## Rollback

```bash
nexaas upgrade --rollback
```

Checks out the recorded previous ref (re-attaching to the branch for legacy
tracking-branch installs, detached otherwise), rebuilds, restarts the worker,
health-checks, and writes the `framework_rolled_back` WAL op. The ref being
left becomes the new previous ref, so a mistaken rollback can be rolled
forward with a second `--rollback`.

**Rollback is code-only. Migrations are NOT reverted.** After a rollback,
release N−1's code runs against release N's schema. That only works because
of the enforced policy:

> **Every migration must be backward-compatible one release**: code N reads
> schema N, and code N−1 must also run correctly against schema N.

Concretely, a migration shipping in release N may:

- **Add** tables, columns, indexes — new columns must be nullable or carry a
  `DEFAULT`, so N−1's INSERTs (which don't mention them) still succeed.
- **Relax** constraints (e.g. dropping a NOT NULL) — N−1 writes that satisfied
  the stricter constraint still satisfy the looser one.

It may NOT:

- **Rename or drop** any table/column/view that release N−1 reads or writes.
- **Tighten** constraints in ways N−1's writes would violate (new NOT NULL
  without default, new CHECK rejecting values N−1 produces).
- **Change semantics** of existing columns that N−1 interprets differently.

Removals happen in **two phases across releases**: release N stops reading
and writing the thing (code change only); release N+1 ships the migration
that drops it. By then no supported rollback target touches it. (Example in
the history: code stopped touching the vestigial `public.*` tables long
before migrations 024 dropped them.)

## Observability

- `nexaas status` — running version (`git describe --tags --always`) and
  configured channel.
- `nexaas_memory.framework_versions` — install/rollback history per
  workspace (`status`: `installed`, `rolled_back`, `conformance_failed`).
- WAL ops: `framework_upgraded`, `framework_rolled_back`,
  `upgrade_conformance_failed`.
- Fleet heartbeat carries version + commit to the ops dashboard (#216).
