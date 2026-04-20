# Nexaas + Nexmatic Glossary

Vocabulary reference for the Nexaas framework and the Nexmatic business built on it. Terms are alphabetical. One-sentence minimum; longer when the concept has subtleties worth surfacing.

For framework conceptual context, see [`architecture.md`](./architecture.md). For skill authoring, see [`skill-authoring.md`](./skill-authoring.md). For business-layer context, see [`nexmatic.md`](./nexmatic.md).

---

**Agentic Loop** — The multi-turn execution pattern where Claude calls MCP tools iteratively: send prompt → Claude returns tool_use → execute tool → send result → Claude continues → repeat until done. Each turn is WAL-recorded. The core of how AI skills operate in Nexaas.

**AI Skill** — A skill with `execution.type: ai-skill` that runs through the full Nexaas pillar pipeline: MCP connection, CAG context assembly, agentic loop with Claude, TAG policy routing, palace recording, cost tracking. Contrasts with shell skills which bypass the pipeline.



---

**Agent** — A deployable bundle of skills sharing a domain (Accounting, Marketing, Operations, etc.), with declared capability requirements, channel roles, a palace taxonomy, and a default contract. Framework primitive. Nexmatic maintains specific agent bundles in its library.

**Agent bundle** — Same as Agent. "Bundle" emphasizes the composable, installable nature.

**Append-only** — The palace never deletes. Drawers are superseded or marked dormant/expired, but the historical record is preserved. Enables free audit trails and time-travel queries.

**Archetype** — A starter template in a pattern library. New skills stamp from the closest archetype via the factory's authoring interview rather than starting blank. Archetypes are business-specific; Nexmatic provides its own pattern library.

**Authoring Interview** — The structured conversation the factory walks an operator through to produce a new skill. Each answer maps to a specific field in the generated artifact. Different consuming businesses configure different interview questions.

**Behavioral Contract** — The per-workspace rules layer that TAG consults alongside the skill manifest. Derived from onboarding configuration. Contains tone, approval posture, escalation rules, `skill_overrides` that adjust routing within envelopes the skill author permits, and `schema_extensions` for per-workspace field additions.

**BullMQ** — The reference execution runtime for Nexaas, backed by Redis per workspace VPS. Provides job scheduling, retries, concurrency control, sandboxed workers, Flows for sub-task dependencies, and graceful shutdown. The framework uses BullMQ under the pillar pipeline for skill step execution.

**Bull Board** — The operational dashboard for BullMQ queues. Embedded in the Nexmatic Ops Console to provide per-workspace queue observability, retry tooling, and failure inspection.

**CAG (Context-Augmented Generation)** — First pillar. Assembles the full context a skill needs — behavioral contract, live workspace state, workflow execution state — by walking the palace before the model acts. Runs at the start of every skill step.

**Capability** — A named abstract interface for a class of integration (e.g., `bank-source`, `accounting-system`, `document-store`). Skills declare capability needs; workspace manifests bind capabilities to concrete MCP implementations. Enables one skill to run unchanged across workspaces with different integrations.

**Capability stage** — The maturity level of a capability interface. Experimental → Converging → Stable. Interface contracts formalize as a capability matures; Stable capabilities require conformance test coverage.

**Channel** — A capability specialized for human communication. Skills reference channels by **role** (`reviewer_notification`, `receipt_intake`, `approval_gate`); workspace manifests bind roles to concrete kinds (email, Telegram, dashboard, Slack) plus MCP + config. Channels are two-way: inbound writes to `inbox.*`, outbound reads from `notifications.*`.

**Channel role** — The abstract name a skill uses to reference a channel in its manifest. Bound in the workspace manifest to a concrete channel kind + MCP + config.

**Channel kind** — The concrete type of channel adapter (email-outbound, messaging-outbound, dashboard-upload-channel). Bound to a role by the workspace.

**Claude Agent SDK** — The Anthropic TypeScript SDK used inside the model gateway to invoke Claude models. Skills do not use this directly — they call the model gateway, which routes through the SDK when the bound provider is Anthropic.

**Claude Code CLI** — A tool installed on every workspace VPS for operators to SSH in and run interactive Claude sessions for troubleshooting and maintenance. NOT used for skill execution. Billed through Claude Max subscriptions, not through the framework's Anthropic API key.

**Closet** — Precomputed pointer/landmark index of drawers in a room (format: `topic | entities | → drawer_ids`). Purpose: fast scanning of a room without loading every drawer. Concept lifted from MemPalace. Computed by a background compaction task per workspace.

**Closet staleness** — How far behind compaction is for a given room, measured at CAG read time as the number of live-tail drawers CAG had to fetch because they were newer than the last compaction watermark. Tracked as telemetry and categorized as Healthy, Drifting, or Choked.

**Contract** — A set of rules TAG enforces. Three types: **Behavioral** (per-workspace tone and policy), **Data** (per-workspace integration configuration), **Skill** (per-skill manifest declaring outputs and routing defaults).

**Coordinator** — The main model invocation in a skill run, as distinct from Layer-1 sub-agents it may delegate to. Holds the overall flow; sub-agents handle narrow specialist tasks.

**Custom domain** — A client-owned DNS name (e.g., `nexaas.envirotem.ca`) pointed at their workspace VPS. Self-service through the client dashboard. The default subdomain (e.g., `<workspace>.nexmatic.ca`) stays active alongside any custom domains.

**Dormant drawer** — A drawer with `dormant_signal` set. The palace-level representation of a waitpoint. Resolved when an external event triggers `resolveWaitpoint(signal, resolution)`.

**Drawer** — The fundamental unit of palace memory: raw text content plus metadata facets (`workspace`, `wing`, `hall`, `room`, `skill_id`, `run_id`, etc.). Everything observable in Nexaas is a drawer. Term borrowed from MemPalace.

**Effective policy** — The final routing for a skill's output after TAG applies both manifest defaults and contract overrides. Visible in the Ops Console per workspace × skill, with the authorization chain that produced it.

**Event** — A drawer written to an `events.*` room, which can fire event-type triggers in subscribing skills. The palace serves as the event bus; no separate message broker is needed.

**Event-driven composition** — The pattern by which skills communicate: skill A writes a drawer to an event room, skill B's manifest subscribes to that room, skill B fires. Cross-skill choreography via palace writes.

**Factory** — The authoring system that produces new skills and flows. The framework (Nexaas) provides the primitives; a consuming business (Nexmatic) provides the specific slash commands, interview questions, archetype library, and curation discipline.

**Flow** — A client-specific business workflow assembled from skills. Flows are composed per-workspace; skills are primitive and library-resident. Flows live in the workspace, reference skills by id + version + binding, and are editable via factory slash commands.

**Four Pillars** — CAG, RAG, TAG, Contracts. The core Nexaas execution model. Every skill run flows through CAG → RAG → Model → TAG, with Contracts providing the rules TAG enforces.

**HNSW** — Hierarchical Navigable Small World, the vector index type pgvector uses for sub-10ms nearest-neighbor search over drawer embeddings at our scale.

**Interface contract (capability)** — The documented tool names, input shapes, and output shapes that any MCP claiming a given capability must implement. Versioned. Matures through capability stages.

**Library** — The collection of canonical skills, flows, archetypes, MCP implementations, and agent bundles that a consuming business maintains and propagates to its clients. Nexmatic has its own library; Phoenix Voyages would have a separate one.

**Library retrieval** — RAG over the library itself. The factory queries the library by semantic similarity at authoring time to suggest reuse or forking from existing skills when building new ones. Makes the factory get faster as the library grows.

**Locus** — MemPalace term for a memory record. Synonymous with drawer in the cognitive-metaphor sense. Nexaas uses "drawer" as the primary term.

**MCP Client** — The Nexaas runtime component that connects to MCP servers via the stdio protocol. Spawns the server as a child process, sends JSON-RPC messages (initialize, tools/list, tools/call), and normalizes tool schemas (inputSchema → input_schema) for the Anthropic API.

**MCP (Model Context Protocol) server** — A service implementing one or more capabilities. Provides normalized tool interfaces to the model. The only component that knows about external systems like Plaid, QBO, Paperless, Telegram. MCPs contain the chaos of real-world integrations. Nexmatic maintains its own MCP implementations in its repository.

**MemPalace** — The open-source project whose conceptual model we ported to Nexaas. We do not run their code (Python / SQLite / Chroma / stdio) but we adopted their insights: drawers as verbatim records, wings/halls/rooms as flat metadata facets, WAL for audit, normalization-version gate for re-mining.

**Model gateway** — The framework component that handles all model invocations. Provides provider-agnostic execution, tier-based selection, fallback chain management, cost tracking, tool-use format normalization. Skills and the pillar pipeline use it; direct provider SDK calls are forbidden.

**Model tier** — Semantic grade of a model call. `cheap`, `good`, `better`, `best`. Skill steps declare the tier they need; the model registry maps tiers to concrete providers and models, with fallback chains per tier.

**Nexaasify** — The process of converting an existing automation (Trigger.dev task, n8n workflow, cron script, `claude --print` hack) into a proper Nexaas AI skill that runs through the full pillar pipeline. Key changes: Claude Code CLI → Agent SDK via ModelGateway; shell scripts → MCP tools; local files → palace drawers; stdout logging → WAL audit trail; no policy → TAG enforcement; Max subscription → API key with tier-based billing. See `skill-authoring.md`.

**Nexaas** — The framework this documentation describes. The Four Pillars (CAG, RAG, TAG, Contracts) running over a MemPalace-derived palace substrate, with BullMQ execution, pgvector retrieval, ed25519 operator signing, and provider-agnostic model gateway. Owned by Al personally via Systemsaholic, licensed perpetually to Nexmatic and Phoenix Voyages.

**Nexmatic** — The commercial business built on the Nexaas framework. Sells AI business automation to SMB clients via per-client Nexaas workspaces with Nexmatic's library and Ops Console. Distinct from Nexaas in ownership, repository, and license; depends on Nexaas as a versioned package.

**Normalize version** — Integer field on every drawer. Bumping the normalize version of a drawer schema triggers automatic re-mining of older content. Clean migration pattern for evolving memory structures.

**Ontology** — The canonical registry of wings, halls, and room patterns in the palace, maintained at the framework level. Adding a new top-level wing requires a PR against the ontology file.

**Operator** — A person authorized to perform privileged actions. Roles: `ops_admin`, `ops_member`, `client_admin`. Each operator has a registered identity and one or more signing keys. Every privileged action is signed.

**Operator key** — An ed25519 keypair tied to an operator identity. Public key stored in `operator_keys` registry; private key held by the operator (file for Tier 1, device for Tier 2 WebAuthn). Signs privileged WAL rows.

**Ops Console** — The operator-facing dashboard for fleet management. The framework provides a console **core** (palace browser, WAL viewer, effective policy inspector, etc.); a consuming business extends the core with its own application. Nexmatic's Ops Console is a business-specific extension.

**Organic buildout** — The model by which the library grows: new skills are authored in response to real client needs, contributed back to the library, curated, and made available for future clients. Contrasts with top-down library planning. Makes the factory faster over time as the library matures.

**Outbox (transactional)** — Pattern for maintaining atomicity across Postgres and Redis. State transitions write to Postgres in one transaction along with an outbox intent row; a separate relay process reads the outbox and enqueues BullMQ jobs. Survives crashes between the two steps.

**Palace** — The per-workspace memory substrate. A scoped query space over drawers. Implemented on Postgres (metadata, WAL, waitpoints) + pgvector (semantic retrieval). The spine that every other component attaches to. One palace per workspace.

**Palace footprint** — The explicit declaration in a skill manifest of which rooms it reads from (retrieval), writes to (output), subscribes to (triggers), and emits to (downstream triggers). Gives a static map of skill-to-room relationships.

**Pattern library** — The set of archetype templates used by a consuming business's factory. Nexmatic maintains its own pattern library in its repository.

**Persona** — Layer-3 sub-agent concept: a persistent model configuration with its own palace wing and voice, owning a set of specialist skills. Schema field reserved in v1; runtime implementation deferred to v1.2+.

**Pillar Pipeline** — The fixed CAG → RAG → Model → TAG → engine execution path every skill step follows. Deterministic in shape; what varies is the context assembled, the retrieval performed, the model prompt, the routing decisions, and the engine actions.

**pgvector** — The Postgres extension providing vector similarity search. Per workspace VPS. Stores drawer embeddings in a dedicated table with HNSW indexing. Replaces the legacy Qdrant-based approach.

**Propagation** — The pipeline by which skill updates flow from the canonical library on the ops VPS to subscribed client workspaces. Implemented as proposals (not auto-updates) for major versions; minor versions may auto-apply.

**Proposal (skill update)** — A library update offered to a workspace for review, not auto-applied. Ops or the client reviews the proposal and decides whether to accept or defer.

**RAG (Retrieval-Augmented Generation)** — Second pillar. Retrieves semantically similar historical content via pgvector, scoped to workspace + declared retrieval rooms. Runs after CAG so retrieval is context-informed.

**Resolution drawer** — The drawer written when a waitpoint is resolved. Contains the decision, the authorization chain, and the actor who resolved it.

**Resume** — The act of continuing a skill run after a waitpoint resolves. Implemented by clearing the dormant signal and enqueueing the next skill step via the outbox. State is reassembled via CAG walking the palace — no explicit state deserialization needed.

**Role** (channel) — The abstract name a skill uses to reference a channel in its manifest. Bound in the workspace manifest to a concrete channel kind + MCP + config.

**Room** — A metadata facet on drawers; the third level of the `wing/hall/room` taxonomy. Indexed string column, not a nested object. "Entering a room" is a filtered query; "walking a room" is that filter plus optional similarity search.

**Self-Reflection Protocol** — Required closing block on every skill prompt. Instructs the model to emit `SKILL_IMPROVEMENT_CANDIDATE: [...]` if it notices a better approach during execution. Captured as drawers for the promotion pipeline.

**Signal (waitpoint)** — The unique token identifying a waitpoint. External events resolve waitpoints by calling `resolveWaitpoint(signal, resolution, actor)`.

**Shell Skill** — A skill with `execution.type: shell` that runs a command and records the result. Bypasses the pillar pipeline (no CAG, RAG, TAG, model gateway). Used as a migration convenience for simple cron jobs and scripts. Not a real Nexaas skill — it's a scheduling wrapper. Convert to AI skills where AI reasoning adds value.

**Skill** — The atomic unit of authored work. Contains `skill.yaml` (manifest), `prompt.md` (model prompt), and optionally `task.ts` (pre/post glue). Declares capability requirements, triggers, outputs with TAG routing, palace footprint, optional sub-agent declarations, model tier selection per step.

**Skill contract** — The skill manifest interpreted as a contract. Declares what outputs are safe, what must be gated, what can be overridden, and within what envelope.

**Skill Factory** — The broader authoring system; see **Factory**.

**Skill footprint** — See **Palace footprint**.

**`skill_runs` table** — Denormalized index of active and historical skill runs. Drawers are authoritative; `skill_runs` is a derived index reconstructable from drawers via `rebuild-skill-runs` CLI. Updated by the runtime in the same transaction as drawer writes.

**SKILL_IMPROVEMENT_CANDIDATE** — Marker string a model may emit to signal "a better version of this skill exists." Captured by the feedback collector. Enters the promotion pipeline for curation review.

**Sub-Agent** — A specialized model invocation. Three layers: **L1** (focused invocation inside a skill run, with narrowed prompt/tools/palace), **L2** (specialist skill inside an agent bundle), **L3** (persistent persona — schema reserved, runtime deferred).

**Substrate** — The layer everything else depends on but which doesn't itself depend on anything domain-specific. The palace is Nexaas's memory substrate.

**TAG (Trigger-Action Gateway)** — Third pillar. Post-model routing layer. Evaluates each proposed action against the skill manifest's routing defaults and the behavioral contract's overrides, produces a final routing decision (`auto_execute`, `approval_required`, `escalate`, `flag`, `defer`), and hands it to the engine. Does not make business decisions — only enforces declared rules.

**TAG Option C** — The layered policy model. Skill manifest declares routing defaults and overridability envelope; behavioral contract can override within that envelope; every override is logged with authorization chain to the WAL.

**Tier** — See **Model tier**.

**Tier 1 secret** — Platform-wide credentials shared across all Nexmatic client VPSes (ANTHROPIC_API_KEY, VOYAGE_API_KEY, PLAID_CLIENT_ID, etc.). Maintained as sops-encrypted on the ops VPS, pushed to each client VPS at deploy time.

**Tier 2 secret** — Per-client credentials obtained via OAuth or enrollment, stored in the client's local Postgres encrypted with a per-VPS master key. Per-client OAuth tokens (Plaid access_token, QBO refresh_token) live here.

**Tier 1 signing key** — File-based ed25519 key for the bootstrap operator (Al initially). Used only during early framework bootstrap before WebAuthn is enrolled.

**Tier 2 signing key** — WebAuthn passkey registered via browser platform authenticator (Touch ID, Face ID, YubiKey). Standard for ops team members and all client admins.

**Tombstone (WAL redaction)** — Pattern for removing content from the WAL without breaking the hash chain. A new WAL row `op: 'redact'` references the target row's hash and supplies replacement content. Original stays but readers see the redaction notice.

**Traversal** — Walking from drawer to drawer via filters and similarity. Implementation detail of CAG and RAG, not a separate primitive.

**Trigger** — How a skill starts. Types: `cron`, `event`, `webhook`, `inbound-message`, `manual`, `file-watch` (future). Declared in skill manifest. Event triggers subscribe to drawer writes in `events.*` rooms.

**Voyage-3** — The embedding model used by pgvector indexing. 1024-dimension output, recommended for use with Claude-based systems. Single Tier 1 secret (`VOYAGE_API_KEY`).

**Waitpoint** — A durable pause in a skill run, implemented as a dormant drawer. Created when TAG routes an output to `approval_required`. Resolved when an external event clears the signal: email reply, dashboard click, webhook callback, inbound message.

**Waitpoint timeout reaper** — Background task (60-second cadence) that fires timeout policies for expired waitpoints. Policies: escalate (default), auto_approve, auto_reject, auto_cancel, remind_and_extend.

**WAL (Write-Ahead Log)** — Append-only log of every palace operation with hash chain, for audit and tamper detection. Privileged rows carry ed25519 signatures. Verified bi-daily incremental + weekly full-chain.

**WebAuthn** — The browser-native standard for hardware-backed cryptographic signing. Used for Tier 2 operator keys. Each privileged action triggers a per-action signing gesture (Touch ID, etc.), not a session-wide blank check.

**Wing** — Top-level spatial facet on drawers. First of three levels in the `wing/hall/room` taxonomy. Initial wings: `inbox`, `events`, `knowledge`, `accounting`, `marketing`, `operations`, `notifications`, `ops`, `personas` (reserved), plus domain-specific wings per agent.

**Workspace** — One client's complete, self-contained Nexaas install, deployed on its own VPS. Has its own Postgres (with pgvector), Redis (for BullMQ), MCPs, Claude SDK, palace, dashboard, manifest, behavioral contract, installed agents. Per-VPS isolation is absolute.

**Workspace manifest** — Tenant registry file that is the source of truth for a client's Nexaas deployment. Contains capability bindings, channel bindings, installed agents, behavioral contract overrides, custom domain configuration. Lives in the Nexmatic business-layer repo (`/opt/nexmatic/workspaces/<id>.workspace.json`), not in the Nexaas framework repo — the framework itself is tenant-agnostic.

**Workspace schema extensions** — Per-workspace field additions to canonical skills, declared in the behavioral contract. Example: a client wants an optional Job ID field on all receipts. Lives in the workspace contract, not in the canonical skill. Allows per-client customization without contaminating the library.
