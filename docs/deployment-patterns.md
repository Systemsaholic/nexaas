# Deployment Patterns

Nexaas supports two valid deployment modes, both fully framework-native. The framework is tenant-agnostic by contract — pick the mode that fits the business model, not the other way around.

> **Framework invariant.** Every runtime feature works identically in both modes. No Nexaas code path assumes one or the other. If a proposed feature only works when an operator layer is present (or only when it's absent), the feature is misplaced.

---

## Mode 1 — Direct Adopter

A single workspace running on a single VPS, with no separate operator layer. The workspace owner IS the operator.

**Used by:** Phoenix Voyages (the Nexaas canary). Internal tools. Single-tenant installs that aren't part of a SaaS offering.

### Topology

```
┌─────────────────────────────────┐
│  Direct-adopter VPS             │
│                                 │
│  /opt/nexaas            ← framework source
│  /etc/nexaas/workspaces ← workspace manifest lives here
│  /opt/workspaces/<id>   ← workspace runtime root (NEXAAS_WORKSPACE_ROOT)
│                                 │
│  nexaas-worker.service          │
│  Postgres (nexaas_memory)       │
│  Redis                          │
│  MCP servers                    │
└─────────────────────────────────┘
```

No operator VPS, no propagator, no ops-console. The workspace repo is self-contained.

### Manifest location

Recommended convention: `/etc/nexaas/workspaces/<workspace-id>.workspace.json`

The framework reads from `NEXAAS_WORKSPACE_MANIFEST_DIR` — set in the worker's systemd environment:

```ini
# /etc/systemd/system/nexaas-worker.service.d/direct-adopter.conf
[Service]
Environment=NEXAAS_WORKSPACE_MANIFEST_DIR=/etc/nexaas/workspaces
```

The manifest file is either committed to the workspace repo and deployed via the workspace's own CI, or generated from the workspace repo's build process. Either way, change management is owned entirely by the workspace team.

### Deploy flow

1. Provision VPS, install Nexaas framework (clone or extract release)
2. Run `nexaas init --workspace <id>` — creates DB, migrations, systemd service
3. Drop the manifest at `/etc/nexaas/workspaces/<id>.workspace.json`
4. Restart worker — manifest loads with warnings if malformed, fatal-less if missing
5. Register skills, seed palace, first backup (per `deployment-ops.md §1`)

### Ops tooling

Operators use Claude Code CLI directly on the VPS for maintenance. `nexaas status`, `nexaas health`, `nexaas upgrade` all work without any external operator layer. No dashboard unless the workspace builds its own.

### Framework-update flow

`nexaas upgrade` pulls the framework repo, runs migrations, restarts the worker. The workspace team decides when to pull. No central authority pushes framework updates.

### When to use

- You are the end user of your own workspace
- You don't need multi-tenant billing, plan tiers, or ops-console UI
- You want direct control over the deployment cadence
- Your workspace repo is the source of truth; operator-layer features would be ceremony you don't need

---

## Mode 2 — Operator-Managed

Multiple client workspaces managed by a central operator. The operator runs ops-console, library distribution, and a propagator that syncs manifests to client VPSes.

**Used by:** Nexmatic (the reference operator-managed business). Any commercial layer built on Nexaas.

### Topology

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  Operator VPS                │        │  Client VPS (per tenant)     │
│                              │        │                              │
│  /opt/nexmatic/              │        │  /opt/nexaas                 │
│    workspaces/<id>.json ─────┼─ rsync→┤  /opt/nexmatic/              │
│    ops-console/              │        │    workspaces/<id>.json ←    │
│    client-dashboard/         │        │                              │
│    library/                  │        │  nexaas-worker.service       │
│    propagator/               │        │  (default MANIFEST_DIR       │
│                              │        │   = /opt/nexmatic/workspaces)│
└──────────────────────────────┘        └──────────────────────────────┘
       Tailscale / zero-trust network
```

Operator holds authority for manifest changes, library updates, capability registry distribution. Client VPS runs the framework and pulls from the operator via the propagator. If the operator VPS disappears, client VPSes keep processing skills — only ops visibility and library updates are interrupted.

### Manifest location

Default: `/opt/nexmatic/workspaces/` on each client VPS (the framework's built-in default). Operator maintains the source of truth in the operator's own repo; the propagator rsyncs to `/opt/nexmatic/workspaces/` on each client VPS.

No `NEXAAS_WORKSPACE_MANIFEST_DIR` override needed — the framework default matches.

### Deploy flow (new client workspace)

1. Operator creates a workspace in the ops-console
2. Operator generates a bootstrap secret (per `fleet-protocol.md`)
3. On the client VPS: `nexaas init --workspace <id> --fleet-endpoint ... --bootstrap-secret ...`
4. `nexaas init` registers the VPS with the ops-console, receives a fleet token, writes it to `.env`
5. Operator writes the initial manifest in the operator repo, propagator rsyncs it
6. Client-side worker loads the manifest, comes up ready

### Ops tooling

Operator uses the ops-console (Nexmatic's case: `/opt/nexmatic/packages/ops-console/`) for fleet visibility, palace browsing, WAL inspection, effective-policy viewing, skill propagation. The ops-console reads from the operator's own databases for aggregated views; per-workspace deep dives connect to the client VPS's palace directly over the private LAN.

Clients see a per-workspace dashboard (Nexmatic's `client-dashboard`) exposing only their own data. Never cross-tenant.

### Framework-update flow

Operator stages the framework update in the ops-console, tests against a canary workspace, then approves propagation to the fleet. `nexaas upgrade` on each client VPS pulls the approved commit. Per-workspace opt-in or auto-pull is an operator policy, not a framework feature.

### Commercial layer concerns

Billing, token metering, plan tiers, add-on marketplace, client onboarding UX, custom domain management — all live in the operator layer, not the framework. The framework captures the raw signals (token usage rows on `skill_runs`, fleet heartbeats) that the operator layer consumes for invoicing and gating.

### When to use

- You are selling Nexaas-powered workspaces to customers
- Multiple workspaces need coordinated framework updates, library curation, or policy enforcement
- Centralized ops visibility matters more than per-workspace autonomy
- You have a commercial layer (billing, plans, auth) that wraps the framework

---

## Framework features that work identically in both modes

- **Palace memory** — `nexaas_memory` in each workspace's Postgres. Framework doesn't care whether an operator queries it or only the workspace does.
- **BullMQ runtime** — local Redis per VPS. Same regardless of mode.
- **Skill registration + execution** — `nexaas register-skill` + `nexaas trigger-skill` work on-VPS for both.
- **Capability registry** — at `capabilities/_registry.yaml` in the framework. Read identically.
- **Workspace manifest schema** — validated via `loadWorkspaceManifest`; `NEXAAS_WORKSPACE_MANIFEST_DIR` points at the manifest source in both modes.
- **Fleet heartbeat** — worker emits heartbeats on the interval (per `fleet-protocol.md`). Operator-managed mode consumes them via the ops-console's `/api/fleet/heartbeat`; direct-adopter mode leaves `NEXAAS_FLEET_ENDPOINT` unset and the heartbeat no-ops. Same code, two consumption modes.
- **WAL + palace signing** — ed25519 operator keys work identically. Direct adopter keys live on the workspace VPS; operator-managed keys live on the operator VPS.
- **Retry, guardrails, preflight, verification** — per-skill and per-workspace features (#25, #27, #28, #30, #32) are manifest-declared and run in the same worker.

---

## Framework features that differ (by design, not by accident)

| Concern | Direct adopter | Operator-managed |
|---|---|---|
| Manifest source of truth | Workspace repo | Operator repo |
| Who triggers framework upgrades | Workspace team | Operator (via approved propagation) |
| Library access | Local workspace repo | Operator's curated library + propagator |
| Multi-workspace observability | N/A (single workspace) | Ops-console |
| Billing / plan enforcement | N/A | Operator layer |
| Custom-domain provisioning | Workspace owns its DNS | Operator automates per-client |
| Client-facing dashboard | N/A unless workspace builds one | Operator's client-dashboard |

Nothing on the right side of this table is a framework feature. The left side is what Nexaas ships; the right side is what operator-managed businesses like Nexmatic build on top.

---

## Related

- `architecture.md §16` — Workspace Manifest spec
- `architecture.md §17` — Network Topology (operator + workspace VPS split)
- `architecture.md §23` — Nexmatic is an example business built on Nexaas
- `fleet-protocol.md` — Heartbeat + bootstrap registration (both modes)
- `packages/runtime/src/schemas/workspace-manifest.ts` — canonical manifest schema
