# Nexaas Framework Architecture

**Document status:** Canonical reference for the Nexaas framework
**Last updated:** 2026-04-15

This document describes Nexaas as a framework — the conceptual model, the core abstractions, and how they compose. It is deliberately timeless: no version numbers, no build schedules, no business-specific content. For execution plans, see `v1-refactor-plan.md`. For business-layer concerns specific to Nexmatic, see `nexmatic.md`. For terminology lookup, see `glossary.md`.

---

## 1. What Nexaas Is

Nexaas is an opinionated framework for running context-aware AI execution. It is defined by the Four Pillars — Context-Augmented Generation, Retrieval-Augmented Generation, Trigger-Action Gateway, and Contracts — operating over a MemPalace-derived memory substrate called the palace. A business built on Nexaas gains a durable, auditable runtime for Claude-powered (or other LLM-powered) automation skills, deployable on per-tenant infrastructure, with context continuity across runs and durable pauses for human approval.

Nexaas is a framework, not a product. It does not know what business problems it solves. It knows how to assemble context, retrieve memory, invoke models, enforce policy, and record everything as hash-chained signed drawers in an append-only memory substrate. A consumer of Nexaas — such as the Nexmatic business — uses the framework to deliver a specific offering to end clients.

The framework is built around three core commitments:

1. **Memory-first execution.** Skills do not hold state in local variables. All durable state lives in the palace. Waitpoints are dormant drawers; resumption is palace walking, not process restoration.
2. **Per-workspace isolation.** Each tenant gets its own self-contained Nexaas runtime on its own infrastructure. Orchestration between workspaces is explicit and optional; runtime state never crosses a workspace boundary.
3. **Capabilities over integrations.** Skills declare what they need by abstract capability, not by concrete vendor or API. Workspace manifests bind capabilities to specific implementations at install time.

These commitments are what allow a Nexaas consumer to scale to many tenants without the per-tenant effort growing linearly with tenant count.

---

## 2. Design Principles

These are the tradeoffs the framework always chooses in the same direction. When in doubt, these principles override local convenience.

**Structure over magic.** Every state transition is explicit. Every policy decision is auditable. No hidden replay semantics, no cached reconstruction of function locals, no step-replay determinism constraints. Verbosity is acceptable when it buys debuggability.

**Memory as substrate, not service.** The palace is not a database the application talks to. It is the fabric the application is embedded in. Events, decisions, tool calls, human approvals, errors — all drawers in the palace.

**Append-only by default.** Nothing is deleted. Everything is superseded. The WAL is tamper-evident via hash chains. The audit trail is a free consequence of the data model.

**Capabilities over integrations.** Skills declare what they need, not whom they call. Bindings happen at the workspace boundary. New integrations are MCP implementations of existing interfaces, not new skill code.

**Contracts as policy-as-code.** What a skill may do is governed by a two-layer policy: the skill manifest's author-declared defaults and the workspace's behavioral contract's permitted overrides. Every override carries an authorization chain.

**Per-workspace isolation is the blast radius boundary.** A skill bug on one workspace cannot reach another. Runtime state never crosses workspaces.

**The framework is not the product.** Nexaas provides primitives. A consuming business builds the product by assembling skills, libraries, and branding on top.

---

## 3. The Four Pillars

Every skill execution in Nexaas flows through a fixed pipeline, defined by four concepts.

### CAG — Context-Augmented Generation

Before Claude acts, CAG assembles the full context the skill needs by walking the palace:

- **Behavioral contract**: the workspace's tone, approval posture, escalation rules
- **Live state**: current integration snapshots, active resources, pending items
- **Workflow execution state**: where in the skill's flow the current run is, which drawers already exist, what has been decided so far
- **Retrieval rooms**: room subsets the skill declares for CAG to walk

CAG is not a preamble — it is the first-class operation. A skill without CAG is not a Nexaas skill; it is a job. The context that arrives at Claude's prompt is a composition of palace queries scoped to the current run.

### RAG — Retrieval-Augmented Generation

After CAG, RAG retrieves relevant historical content via semantic search. The palace backs vector embeddings via pgvector with Voyage-3 embeddings, namespaced per workspace and scoped to declared retrieval rooms.

What RAG adds beyond CAG's room walks:

- CAG says "load drawers from these rooms"
- RAG says "of those drawers, rank by relevance to this run's query and bring the top N into context"

For skills at small scale, RAG is often a no-op — every drawer is already in CAG context. For skills at mature scale with thousands of drawers per room, RAG is the difference between dumping everything into the model window and retrieving exactly the drawers that matter.

### TAG — Trigger-Action Gateway

After the model produces output, TAG evaluates each proposed action against policy and routes it. TAG does not make business decisions; it enforces the rules declared in:

1. The **skill manifest**'s routing defaults (`routing_default`, `overridable`, `overridable_to`)
2. The **behavioral contract**'s `skill_overrides`

Routing outcomes:

- **`auto_execute`** — take the action immediately
- **`approval_required`** — create a waitpoint, notify a human, suspend the run
- **`escalate`** — create an escalation drawer, notify ops, continue or suspend depending on context
- **`flag`** — write a drawer tagged for review, continue
- **`defer`** — reschedule the next step for later

### Contracts

Contracts are the rules TAG enforces. Three kinds:

- **Behavioral contract** (per-workspace): tone, approval posture, escalation thresholds, skill-level routing overrides, schema extensions for per-workspace field additions
- **Data contract** (per-workspace): which integrations are enabled, what data flows where, privacy posture
- **Skill contract** (per-skill, in `skill.yaml`): inputs, outputs, capability requirements, TAG routing defaults, palace footprint

The behavioral contract can override the skill contract only within envelopes skill authors allow (`overridable: true` + `overridable_to: [...]`). Every override is logged to the WAL with authorization details.

---

## 4. The Palace

The palace is the memory substrate. It is ported conceptually from MemPalace and adapted for Nexaas's multi-tenant, Postgres-backed, TypeScript-native stack.

### Core Concepts

- **Palace** — one per workspace. A scoped query space over all drawers belonging to that workspace.
- **Drawer** — the fundamental unit of memory: raw text content plus metadata facets. Everything observable in the system is a drawer.
- **Wing / Hall / Room** — three levels of metadata taxonomy. Not nested objects; flat indexed string columns on every drawer. "Entering a room" is a filtered query.
- **Closet** — a precomputed pointer index (`topic | entities | → drawer_ids`) for fast scanning of a room without loading every drawer.
- **Waitpoint** — a drawer with `dormant_signal` set, suspended until resolved via external event.
- **WAL** — write-ahead log of every palace operation, hash-chained per workspace, with ed25519 signatures on privileged rows.
- **Normalize version** — schema version on every drawer; bumping triggers re-mining of older content when structure evolves.

### Flat Metadata, Not Nested Graphs

Rooms are not nested objects. They are flat indexed metadata columns. A drawer is tagged with `{wing: 'knowledge', hall: 'brand', room: 'voice'}`. Walking the palace is filtered SQL. Traversal is filter composition. Entering a context is a query scope.

This gives structured browsing (filter by room), semantic search (vector similarity over drawer text), and free-form traversal (any combination of filter + similarity) without a second database.

### The Palace as Spine

Every component attaches to the palace; no component talks to another directly. CAG reads drawers to assemble context. RAG retrieves via pgvector scoped to rooms. TAG writes decisions as drawers. Triggers subscribe to drawer writes in `events.*` rooms. Channels write inbound drawers to `inbox.*` rooms and read outbound drawers from `notifications.*` rooms. Sub-agents operate on narrowed palace scopes. MCP servers record their side effects as drawers.

The consequence: operational observability is a palace browser with good filters. There is no bespoke run inspector — the same query surface serves every skill, every workspace, every audit.

### Durable Pauses

A waitpoint is not a parallel concept bolted onto the runtime. It is a drawer with `dormant_signal` set, living in whatever room makes sense for its skill. When an external event resolves the signal, the signal is cleared, a resolution drawer is appended, and the next skill step is enqueued.

State across the pause is preserved because state never lived in the skill's local variables. The skill is stateless; the palace is the state. Resuming is structurally identical to walking back into a room.

This is how the framework handles "wait 3 days for a human to approve this" without event-log-replay infrastructure.

### WAL — Tamper-Evident Audit

The write-ahead log records every meaningful operation: drawer writes, TAG routings, waitpoint resolutions, escalations, contract overrides, MCP tool calls, run state transitions, privileged operator actions.

Each row carries a sha256 hash chained to the previous row's hash in the same workspace's WAL:

```
hash = sha256(prev_hash || canonical(op + actor + payload + created_at))
```

Modification of any historical row breaks the chain's verifiable state. Verification walks the chain from genesis and flags discrepancies. Redaction happens by tombstone pattern — never hard delete.

Privileged WAL rows carry an additional ed25519 signature from the operator who authorized them. Operator identities and public keys live in a dedicated registry; signatures bind to the chain position by including `prev_hash` in the signed payload.

### pgvector + Voyage-3

Vector retrieval runs on pgvector installed in the per-workspace Postgres. Voyage-3 produces 1024-dimension embeddings for drawer text. A `nexaas_memory.embeddings` table holds vectors with HNSW indexing for sub-10ms similarity queries at our scale. This replaces the legacy Qdrant-based approach and eliminates the need for a separate vector service per VPS.

### Closet Compaction

Closets are computed by a background compaction task, scoped per workspace, running on a short cadence (default every 5 minutes during business hours, every 30 minutes off-hours). Compaction groups drawers in rooms with shared metadata facets and time proximity, producing pointer rows that CAG can scan cheaply before loading underlying drawers.

CAG reads both closets (for drawers older than the last compaction watermark) and raw live-tail drawers (newer than the watermark). Staleness telemetry is emitted per CAG read, aggregated per room, and surfaced in three health tiers (Healthy, Drifting, Choked). Sustained choked rooms escalate automatically.

---

## 5. Capabilities

A **capability** is a named abstract interface for a class of integration. Skills declare what capabilities they need; workspaces bind capabilities to concrete MCP implementations.

This is the mechanism that lets one skill run unchanged across workspaces with entirely different integration stacks.

### Example

A `transaction-matching` skill requires:
- `bank-source` — list transactions
- `accounting-system` — find and attach entries
- `document-store` — retrieve receipts

One workspace binds `bank-source → Plaid`, `accounting-system → QBO`, `document-store → Paperless`.
Another workspace binds `bank-source → custom scraper`, `accounting-system → Wave`, `document-store → Paperless`.

Same skill. Different MCPs injected at session creation. Zero skill code differences.

The model sees normalized tool names (`bank-source.list_transactions`) regardless of which MCP is bound underneath. The capability layer is the abstraction; MCP servers implement it.

### Interface Contracts

Each capability has a documented interface: tool names, input shapes, output shapes, error codes. Interface contracts are versioned and mature through three stages:

- **Stage 1 (Experimental)**: first MCP implementation, provisional interface, interface version `0.x`, prose documentation
- **Stage 2 (Converging)**: 2+ implementations force generalization, interface version `1.0-beta`, JSON schemas written, existing skills audited
- **Stage 3 (Stable)**: 3+ implementations, interface version `1.0`, conformance test suite required, runtime validation enforced

Stages are visible in the capability registry. Stage transitions are explicit operator actions. Skills pin the interface version they were written against.

Backward compatibility across major versions is provided via parallel-version support (MCPs can implement v1 and v2 simultaneously) with declared deprecation windows, defaulting to 6 months.

### Conformance Tests

At Stage 3, a capability requires a conformance test suite that new MCP implementations must pass. Tests validate interface conformance (tool presence, input/output schema, error shapes, idempotency) against a fake backend, not real external systems. Tests are typically ~200 LOC per capability, run in seconds, and are reusable across all implementations.

---

## 6. Model Gateway

The framework does not assume a specific LLM provider. Every model invocation flows through the **ModelGateway**, which provides a provider-agnostic interface with tier-based selection and explicit fallback chains.

### Tier-Based Selection

Skills declare what **tier** of model they need per step:

- **`cheap`** — narrow, deterministic, high-volume (validation, extraction, classification)
- **`good`** — routine reasoning, drafting, simple multi-step logic (default)
- **`better`** — complex reasoning, multi-context integration, branching decisions
- **`best`** — highest-stakes or most creative work (brand voice, nuanced judgment)

Authors think about task difficulty, not model names. The tier maps to a concrete provider + model via the registry.

### Model Registry

A YAML registry (`capabilities/model-registry.yaml`) declares providers and tier mappings. Each tier has a primary model and an ordered fallback chain. Providers are declared abstractly with kinds (`remote-api`, `openai-compatible`) so new providers — including self-hosted open-source models — slot in by adding an entry.

### Provider-Agnostic Execution

The gateway:
1. Resolves the tier to a primary model via the registry
2. Applies workspace contract model policies (provider caps, tier caps, cost caps)
3. Checks context window fit
4. Invokes the primary provider with the right SDK
5. On retryable failures, walks the fallback chain, logging each attempt
6. Normalizes tool-use formats across providers (Anthropic, OpenAI, OpenAI-compatible)
7. Records usage, cost, and provider attribution for the call
8. Returns a normalized result

Workspace contracts can cap provider choice, cap tier level, cap daily cost, or force specific providers for compliance reasons. All policy overrides are signed operator actions.

---

## 7. Execution Runtime

The pillar pipeline runs on top of a job execution runtime that provides scheduling, retries, concurrency control, and sandboxed worker processes.

### BullMQ-Backed Execution

The reference runtime uses **BullMQ** (backed by Redis) per workspace VPS. BullMQ provides:

- Per-queue concurrency limits
- Per-key concurrency (workspace-scoped) to prevent one runaway skill from starving others
- Exponential backoff retries
- BullMQ Flows for sub-task dependencies
- Sandboxed processors for worker isolation (prevents worker leaks via graceful cgroup inheritance)
- Graceful shutdown on SIGTERM
- Bull Board for operational observability

### Transactional Outbox

Because state crosses two stores (Postgres for the palace and `skill_runs`, Redis for the job queue), atomicity is handled via the transactional outbox pattern. State updates write an outbox intent row in the same Postgres transaction; a relay process reads the outbox and enqueues to Redis. If the relay crashes, the intent survives and retry succeeds.

### `skill_runs` Denormalized Index

A dedicated `skill_runs` table holds one row per run, indexed for fast operational queries: active runs by workspace, runs waiting on waitpoints, runs by status, parent-child sub-agent trees. Drawers remain the authoritative record; `skill_runs` is a derived index reconstructable from drawers.

The runtime maintains `skill_runs` via a library function (`runTracker.ts`) that wraps every drawer write with the corresponding state transition in a single transaction. Skill authors never touch `skill_runs` directly.

---

## 8. Agents

An **Agent** is a deployable bundle of skills that share a domain. An agent declares:
- The skills it contains
- The capabilities those skills collectively require
- The channel roles it uses
- A palace taxonomy — which wings and halls it owns
- A default contract — sensible defaults for approval policies, schedules, retention

Installing an agent on a workspace is a single operation that verifies bindings exist, copies skills into the active set, merges the default contract with the workspace contract, registers triggers, and runs a smoke test.

Multiple agents compose on the same workspace. Agents can share rooms under the workspace palace, allowing cross-agent state sharing with explicit opt-in.

---

## 9. Skills

A skill is the atomic unit of authored work. Its anatomy:

- **`skill.yaml`** — manifest: id, version, triggers, capability requirements, outputs with TAG routing, palace footprint, sub-agent declarations, model tier selection per step
- **`prompt.md`** — the model prompt, including the Self-Reflection Protocol
- **`task.ts`** (optional) — thin glue for pre/post logic

Most skills don't need `task.ts`. The pillar pipeline runs automatically from the manifest + prompt.

### Palace Footprint

Every skill declares its palace footprint explicitly:

- **retrieval_rooms**: which rooms CAG walks for context
- **writes_to**: which rooms TAG outputs go to
- **subscribes_to**: which event rooms trigger this skill
- **emits**: which event rooms this skill writes to for downstream triggers

This gives a static map of skill-to-room relationships, invaluable for debugging, audit, composition analysis, and impact assessment when changing room ontology.

### Self-Reflection Protocol

Every skill prompt ends with a self-reflection block that instructs the model to emit `SKILL_IMPROVEMENT_CANDIDATE: [...]` if it notices a better approach during execution. The marker is captured as a drawer in `events.skill.improvements` and feeds the promotion pipeline.

---

## 10. Flows

A **flow** is a client-specific business workflow assembled from skills. Flows are composed; skills are primitive. A client's "Receipt Flow" might use `telegram-image-trigger`, `ocr-image`, `paperless-upload`, `qbo-match`, and `email-notify` skills composed together with specific bindings.

Flows live in the workspace and reference skills by id + version + binding. A consuming business's library contains skills; clients' flows live per-workspace and are version-pinned against specific skill versions.

Flow-level operations the framework supports:
- **New flow** authoring via factory slash command
- **Attach skill to flow** — adding a new trigger or step to a running flow
- **Fork flow** — creating a new flow based on an existing one with variations
- **Version-lock flow** — pinning skill versions so upstream updates don't silently affect this flow

---

## 11. Sub-Agents

Sub-agents exist at three layers and compose.

### Layer 1 — Focused Invocations

A skill step can spawn specialized model invocations inside its run. Each has a narrowed system prompt, a tool subset, a palace scope, and a typed return shape. Declared in manifest, invoked via `runtime.subagent(id, input)`, returns a typed result.

This is how the framework keeps main-skill context windows manageable. A coordinator delegates to specialists the way a manager delegates to team members.

### Layer 2 — Specialist Skills in an Agent Bundle

When an agent contains multiple skills — bank reconciliation, invoicing, reporting — those are Layer 2 sub-agents. No new runtime primitive; just skill composition at the agent level with shared state via shared rooms.

### Layer 3 — Persistent Personas (Reserved)

A persona is a long-lived model configuration with its own palace wing and voice, owning a set of specialist skills. Outputs can route through the persona for voice-consistent human-facing messages. The manifest schema field is reserved; runtime implementation is deferred.

---

## 12. Triggers

Skills declare triggers abstractly. The trigger type registry is the plugin surface.

### Trigger Types

- **`cron`** — schedule-based, self-contained. Implementation: `packages/runtime/src/worker.ts` (scheduler self-heal walks manifests + upserts BullMQ job schedulers). Self-healing on every worker restart from `nexaas-skills/**/skill.yaml`.
- **`event`** — (future) subscribes to drawer writes in `events.<dotted.path>` rooms
- **`inbound-message`** — binds to a channel role; incoming messages through that channel fire the skill. Implementation: `packages/runtime/src/tasks/inbound-dispatcher.ts`. Polls `inbox.messaging.<role>` drawers, matches against manifests declaring `triggers: [{type: inbound-message, channel_role}]`, fans out parallel BullMQ jobs (one per subscriber).
- **`webhook`** — (future) exposes an HTTP endpoint; external systems POST to trigger
- **`manual`** — fired from the operator console or client dashboard with ACL checks
- **`file-watch`** — (future) fires on file system events in a watched directory

### Event-Driven Composition via Palace Writes

Events are drawers, not a separate bus. Skill A writes a drawer to `events.invoicing.pending`; skill B's manifest subscribes to that room; when the drawer lands, the trigger fires skill B.

Cross-skill choreography is expressed entirely through palace writes. No new infrastructure, no message broker, no webhook dance. Every event is automatically audit-logged and retroactively inspectable.

### Dispatch tracking

Drawer-driven trigger firings are tracked in `nexaas_memory.inbound_dispatches` keyed by `(workspace, drawer_id, skill_id)`. Re-polls never re-fire the same (drawer, skill) pair. No-subscriber drawers get a sentinel row so they're not rescanned; operators can clear sentinel rows to replay historical drawers if a new skill subscribes.

---

## 13. Channels

Channels are capabilities specialized for human communication. Skills reference channels by **role**, not by kind.

### Role vs. Kind

A skill declares `notify.channel_role: reviewer_notification`. A workspace manifest binds `reviewer_notification → email-outbound → resend → kevin@envirotem.ca` or `reviewer_notification → messaging-outbound → telegram → andre@telegram`. Same skill, different human, different channel.

### Inbound and Outbound

Channels are two-way. Inbound adapters poll or webhook-receive messages, write them to `inbox.messaging.<role>` drawers using the v0.2 canonical shape (content, attachments, action_button_click, reply_to, edited — see `capabilities/_registry.yaml`); the inbound dispatcher fires subscribed skills. Outbound adapters don't run in-workspace — the outbound dispatcher (`packages/runtime/src/tasks/notification-dispatcher.ts`) watches `notifications.pending.*` drawers, resolves the target channel_role via the workspace manifest, invokes the bound channel MCP's `messaging-outbound.send` tool, writes delivered/failed receipt drawers to `notifications.delivered.<kind>.<role>` / `notifications.failed.<kind>.<role>`.

Both directions flow through the palace.

### Idempotency

Outbound dispatches are claimed atomically in `nexaas_memory.notification_dispatches` keyed by `(workspace, idempotency_key)`. A skill author supplies a deterministic key; the framework enforces exactly-once delivery even across worker crashes and BullMQ retries. Adapters that post successfully record `channel_message_id` on the row so subsequent edits / deletes can target the native id.

### Approval round-trip

An approval-request output (TAG `routing: approval_required`) emits a specially-shaped drawer to `notifications.pending.approvals` (with `run_id` in drawer content; #56 cleanup) that the outbound dispatcher delivers with inline buttons. When the human taps a button, the channel adapter writes an `inbox.messaging.<role>` drawer with `action_button_click.{button_id, message_id}`. A companion approval-resolver task (`packages/runtime/src/tasks/approval-resolver.ts`) correlates the click against `notification_dispatches.channel_message_id` to locate the originating approval, then calls `palace.resolveWaitpoint(signal, decision, actor)` and writes an outbox entry for skill resumption.

Channel adapters don't encode any framework knowledge in button callback data — they report native `message_id` + `button_id`, and the framework's dispatch table does the lookup. Any v0.2-conformant messaging channel plugs in.

---

## 14. TAG Policy Enforcement

TAG enforces a **two-layer policy** (Option C): skill manifest + behavioral contract with explicit override envelopes.

### Skill Manifest

Declares routing defaults per output kind and what overrides are allowed:

```yaml
outputs:
  - id: register_promotion
    routing_default: approval_required
    overridable: false              # manifest-locked

  - id: create_landing_page
    routing_default: auto_execute
    overridable: true
    overridable_to: [approval_required]
```

### Behavioral Contract

Can override within the allowed envelope, with authorization trail:

```yaml
skill_overrides:
  - skill: marketing/social-creative-approval
    output: post_social_creative
    routing: auto_execute
    authorized_by: al@nexmatic.ca
    authorized_at: 2026-03-15
    reason: "6 months clean runs, client sign-off"
```

Every override (accepted or denied) is written to the WAL with full authorization chain. The operator console surfaces an **Effective Policy** view per workspace × skill showing manifest default, contract override attempt, and final effective routing.

---

## 15. Operator Identity & Signing

Privileged actions are cryptographically signed by the operator who authorized them. The framework provides:

- **Operators** table with display name, email, role (`ops_admin`, `ops_member`, `client_admin`), workspace scope
- **Operator keys** table with ed25519 public keys, key source (`file`, `webauthn`, `hsm`), rotation support
- **Signing library** that wraps privileged WAL writes with canonical serialization + signature
- **Verification tooling** (`verify-wal`) that walks the chain and validates both hashes and signatures

### Tiers

- **Tier 1**: file-based key for bootstrap operators (single operator case)
- **Tier 2**: WebAuthn/passkey via browser platform authenticators — the standard for everyone else (ops team members, client admins)
- **Tier 3**: HSM/KMS — reserved for future compliance requirements

### Privileged Action Categories

The framework signs at least these categories of privileged actions:

1. Workspace genesis (who provisioned this workspace)
2. Skill installation / uninstallation
3. Agent bundle installation
4. Behavioral contract edits
5. Operator-initiated waitpoint resolutions
6. Skill propagation pushes
7. WAL redactions (tombstone writes)

Additional categories can be declared by consuming businesses.

### Client Admin Signing

Client admins who can perform privileged actions (approve transactions, edit contracts, tweak configurations) enroll Tier 2 passkeys at first dashboard login and sign every privileged action via per-action WebAuthn gestures. This creates cryptographic non-repudiation for client-side decisions, not just session-authenticated logs.

---

## 16. Workspaces

A workspace is one tenant's complete, self-contained Nexaas install. It has its own Postgres (with pgvector), Redis (for BullMQ), MCP servers, palace, behavioral contract, installed agents, and dashboard.

### Workspace Manifest

The JSON file that is the source of truth for a workspace. Contains:

- **id** and metadata
- **capability_bindings** — capability → MCP mapping
- **channel_bindings** — role → channel kind + MCP + config
- **installed_agents** — active agent bundles
- **behavioral_contract** — tone, approval policies, skill overrides, schema extensions
- **custom_domains** — any client-owned domains pointing at this VPS
- **model_policy** — provider and tier policies

### Per-VPS Isolation

Each workspace runs on its own VPS. The operator console (on a separate VPS) does not hold client state. If the operator console disappears, workspaces continue running — only ops visibility and skill updates are interrupted.

Workspaces do not share state. Cross-workspace data sharing is not supported. Blast radius is bounded to a single workspace.

---

## 17. Network Topology

The framework assumes the following topology:

- **Operator VPS** (the ops machine) runs the operator console, the canonical library distribution, and cross-workspace monitoring. Reachable only via Tailscale (or equivalent zero-trust network).
- **Workspace VPSes** run Nexaas instances. Each has its own public IP and public-facing domain (Tailscale or DNS). Clients access their own dashboard directly over HTTPS; external systems deliver webhooks directly to the workspace VPS.
- **Private LAN between operator and workspace VPSes** (e.g., vRack or equivalent) carries ops traffic: monitoring collection, library propagation, deploy/maintenance SSH. The LAN is a hub-and-spoke topology, not a mesh — workspaces do not see each other.
- **Custom domains** per workspace are self-service: clients add their own DNS records and the local Caddy on the workspace VPS auto-provisions TLS via Let's Encrypt. The default workspace subdomain (e.g., `<workspace>.nexmatic.ca` in the Nexmatic reference implementation) is always provisioned automatically; custom domains are additive.

This topology keeps:
- Client runtime fully autonomous (operator VPS outage does not interrupt automation)
- Ops access centralized and secured (Tailscale-only)
- Public exposure minimized to workspace VPSes (no central ingress bottleneck)

---

## 18. The Factory

The factory is how new skills get built. It is a framework-level primitive: the authoring interview machinery, the slash command registration mechanism, the archetype template loader, the library RAG infrastructure, and the library contribution pipeline.

A consuming business provides:
- The specific authoring interview questions tuned to their use cases
- The archetype library of starter templates
- The curation discipline for library hygiene
- The business-specific slash commands (e.g., `/new-flow`, `/new-skill`)

The framework provides the primitives. The consuming business configures them.

### Authoring Interview

A structured conversation that walks an operator through the creation of a new skill. Each answer maps to a specific field in the generated artifact. Phases cover identity, triggers, context needs (retrieval rooms, MCPs), prompt shape, output kinds and TAG routing, post-approval execution, memory writes, and failure modes.

The first phase (intake) queries the library via RAG to suggest reuse or forking from existing skills before building from scratch. As the library grows, the factory gets faster.

### Pattern Library and Archetypes

Archetypes are starter templates. The factory stamps from the closest archetype via the authoring interview rather than starting blank. Archetypes themselves evolve as the factory learns from real authored skills.

The framework does not ship archetypes; consuming businesses provide them.

### Library Retrieval

The library itself is a palace — canonical skills, flow templates, archetypes, MCP interface docs are all drawers in an ops-palace on the operator VPS. The factory queries it via RAG at authoring time. Cross-pollination happens through this retrieval: new skills are suggested to reuse or fork from existing ones.

### Contribution Pipeline

When a skill is authored for a workspace, the factory can push the skill back to the library (with proper versioning, genealogy tracking, and generalization of client-specific details). Contributions are marked as experimental until curated.

Improvements propagate forward to subscribed workspaces as **proposals**, not automatic updates. Ops reviews proposals before pushing to a running workspace.

---

## 19. Operator Console

The framework provides a **console core** that consuming businesses build their operator dashboards on top of. The core provides:

- Workspace listing and fleet visibility primitives
- Palace browser widgets (walk any room in any workspace)
- WAL viewer (inspect and verify the chain)
- Effective policy inspector (per workspace × skill)
- Agent bundle installer
- Capability registry browser and stage indicators
- Skill propagation UI (proposal review, approval, push)
- Operator directory and key enrollment (WebAuthn + Tier 1 bootstrap)
- Bull Board embedding for queue observability

A consuming business extends the core with its own dashboards, workflows, and branding. The console is a framework primitive that consuming businesses use as a foundation.

---

## 20. Where Chaos Lives, Where Structure Holds

A useful way to check the architecture: know where each kind of variety is absorbed.

**Structure holds in:**
- Skill manifests (one format, versioned)
- The pillar pipeline (fixed execution path)
- Capability interfaces (documented, staged, versioned)
- Palace schema
- TAG routing semantics
- Agent bundle format
- Workspace manifest format
- Model gateway protocol
- The factory authoring interface
- WAL + signing semantics

**Chaos is contained in:**
- MCP server implementations (any language, any integration mess)
- Workspace-specific capability bindings
- Channel adapters (per-kind handling of platform quirks)
- External system failures (error drawers normalize them)
- Workspace behavioral contracts (per-tenant tone, posture, schedules)
- Schema extensions (per-workspace field additions)
- Custom domains (per-workspace DNS choices)

If a new variation doesn't fit the "chaos contained" side, look hard before changing the "structure holds" side. The invariants are what make the framework understandable at scale.

---

## 21. Non-Goals and Boundaries

Nexaas intentionally does NOT:

- Execute arbitrary user code — skills are model prompts with declared tool access
- Support cross-workspace data sharing — per-tenant isolation is absolute
- Run a central control plane — operator consoles are ops tools, not runtime dependencies
- Build custom job queues — BullMQ is the reference runtime
- Replay functions on failure — state lives in the palace, steps are idempotent by construction
- Offer sub-second latency on durable pauses — correctness and simplicity over latency
- Provide in-flight workflow version migration — drain before deploying breaking changes
- Ship in Python — TypeScript-native for the framework (MCP servers are language-agnostic)
- Use SQLite — Postgres-only for durable state

These are boundaries, not tradeoffs. They exist because crossing them breaks scaling properties the framework depends on.

---

## 22. Reading Order

If you are new to Nexaas and building a mental model, read in this order:

1. This document (`architecture.md`) — the conceptual foundation
2. `glossary.md` — vocabulary cheat sheet
3. `v1-refactor-plan.md` — the current execution plan for the first major build-out
4. `nexmatic.md` — an example business built on Nexaas (the Nexmatic reference implementation)
5. A real workspace manifest to see how capability bindings look in practice
6. A real skill manifest to see the authoring shape
7. The palace schema migrations to see the ground truth data model

The architecture doc is stable. The refactor plan changes as work progresses. The business doc reflects the Nexmatic reference implementation. The workspace and skill manifests are where theory meets practice.

---

## 23. Framework vs. Business Layer

Nexaas is the framework. A business built on Nexaas — such as the Nexmatic reference implementation — is a separate concern with its own repository, license, team, and product. The framework is reusable; each business is unique.

Responsibilities split as follows:

**The framework (Nexaas) provides:**
- The runtime and pillar pipeline
- The palace data model and API
- The capability registry and staging lifecycle
- The agent and skill manifest formats
- The sub-agent primitives
- The trigger and channel plugin models
- The WAL + operator signing infrastructure
- The model gateway with tier abstraction
- The factory authoring primitives (interview machinery, library RAG, contribution pipeline)
- The operator console core
- Deploy scripts and provisioning tooling for a Nexaas runtime
- Framework documentation (this doc)

**A consuming business provides:**
- Its own library of canonical skills and flows
- Its own agent bundles
- Its own MCP server implementations
- Its own slash commands (built on factory primitives)
- Its own archetype pattern library
- Its own operator console extensions and branding
- Its own pricing and billing model
- Its own client onboarding process
- Its own curation discipline for library hygiene
- Its own workspace manifests

Nexaas does not know about Nexmatic, Phoenix Voyages, Systemsaholic, or any specific business. Each consuming business depends on Nexaas as a versioned package and builds its product on top.

This separation is architectural. The operational reality is that Nexaas and its first consuming business (Nexmatic) are built in parallel during v1. They ship together, tested together, and launched together. But they are separate repositories under separate IP ownership, with a proprietary license governing the relationship. See the Nexaas LICENSE file for ownership and licensing terms.
