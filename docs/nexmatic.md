# Nexmatic — Business Layer on Nexaas

**Document status:** Canonical reference for the Nexmatic business
**Last updated:** 2026-04-15

This document describes Nexmatic as a business built on the Nexaas framework. For the Nexaas framework itself, see `architecture.md`. For execution plans covering the v1 launch, see `v1-refactor-plan.md`. For terminology, see `glossary.md`.

---

## 1. What Nexmatic Is

Nexmatic is an AI business automation platform for SMB clients, built on the Nexaas framework. Nexmatic sells its clients durable, context-aware AI workflows running on per-client infrastructure — automating accounting, marketing, operations, onboarding, and other business functions that previously required dedicated staff or brittle point solutions.

Nexmatic's product is the **combination of the framework and the library**: clients buy a running Nexaas workspace on a per-client VPS, with the Nexmatic-maintained library of canonical skills and agent bundles propagated to them. Clients get:

- A private per-client VPS with their own runtime, palace, and data
- A branded client dashboard for interaction and approvals
- A library of pre-built skills and agents they can subscribe to
- Custom flows authored by Nexmatic ops as their business needs grow
- Ongoing maintenance, library updates, and operational support

Nexmatic is what clients pay for. Nexaas is the framework underneath.

---

## 2. Relationship to Nexaas

Nexmatic is a commercial consumer of the Nexaas framework under a perpetual unconditional license granted by the Nexaas IP owner (Al, operating as Systemsaholic). Nexaas is a separate repository with separate ownership; Nexmatic depends on it as a versioned package (`@nexaas/*` published via GitHub Packages).

Nexmatic does not own Nexaas. Nexmatic does not have exclusive rights to Nexaas. Other businesses (Phoenix Voyages, Systemsaholic-internal operations, future ventures) may also run on Nexaas under separate license grants. The framework is shared infrastructure; each business built on it is distinct.

Architecturally:
- **Nexaas defines**: the framework's capabilities, primitives, and data model
- **Nexmatic defines**: the library of skills and flows, the archetype patterns, the slash commands, the client dashboard's product UX, the pricing model, the onboarding process, the curation discipline, and the business's brand

The split is deliberate. It keeps the framework reusable, keeps Nexmatic's commercial content distinct from shared infrastructure, and makes it legally clean for the IP owner to use the framework in other businesses without Nexmatic interference.

---

## 3. What Nexmatic Adds on Top of Nexaas

### 3.1 The Canonical Skill Library

Nexmatic maintains a library of reusable skills grouped by agent domain. Initial target domains (filled in as real client needs arrive):

- **Accounting Agent**: bank reconciliation, transaction matching, receipt intake, invoicing, work-order processing, monthly reporting
- **Marketing Agent**: social creative approval, email broadcast, social post scheduling, campaign analytics
- **Operations Agent**: task dispatching, incident escalation, maintenance tracking
- **Onboarding Agent**: new-client intake, document collection, provisioning coordination
- **Support Agent**: inbound ticket routing, response drafting, escalation handling

Each skill in the library is a Nexaas-format skill (`skill.yaml` + `prompt.md` + optional `task.ts`) with Nexmatic-specific prompts, capability requirements, and TAG routing defaults. Skills are versioned, genealogy-tracked, and curated.

The library is Nexmatic's accumulating commercial asset. Its value grows with every skill built for every client — the framework is free to any licensee, but the library is the product.

### 3.2 Agent Bundles

Nexmatic defines specific agent bundles that group related skills with sensible defaults. An agent bundle is a deployable unit: "install the Accounting Agent on this client's workspace" is one operation, not a list of individual skill installations.

Bundles include a default contract that sets reasonable approval thresholds, schedules, retention policies, and notification posture. The client's specific workspace contract can override within skill-declared envelopes.

### 3.3 MCP Server Implementations

Nexmatic maintains MCP server implementations for the integrations its clients use: Plaid, QBO, Wave, Xero, Paperless, Google Workspace, Microsoft 365, Telegram, Resend, GitHub, Stripe, and more as clients demand them. Each MCP server implements one or more Nexaas capabilities and passes the capability's conformance test suite at Stage 3.

MCP servers are Nexmatic property, maintained in the Nexmatic repository, and deployed to client VPSes as part of agent installation.

### 3.4 The Factory Slash Commands

Nexmatic implements the `/new-skill` and `/new-flow` slash commands on top of Nexaas's factory primitives. These commands:

- Walk operators through Nexmatic's authoring interview
- Query Nexmatic's library via RAG to suggest reuse
- Stamp from Nexmatic's archetype pattern library
- Generate Nexmatic-branded skill manifests
- Push contributions back to Nexmatic's library

The authoring experience is a Nexmatic product built on Nexaas primitives. A future business consuming Nexaas could build its own slash commands with different questions and different archetypes — they'd be distinct products on the same framework.

### 3.5 The Ops Console (Nexmatic Edition)

Nexmatic's Ops Console is a Nexmatic application built on Nexaas's operator console core. It provides:

- Fleet visibility across all Nexmatic client workspaces
- Library inbox for reviewing new skill contributions
- Proposal flow for pushing library updates to running clients
- Effective policy inspector for Nexmatic contracts
- Nexmatic-branded UX, terminology, and help content
- Billing and cost tracking (Nexmatic-internal)
- Client account management and onboarding workflows
- Integration health monitoring tailored to Nexmatic's MCP library

The Ops Console codebase lives in the Nexmatic repository. It imports framework components from `@nexaas/ops-console-core` and extends them with Nexmatic-specific views.

### 3.6 The Client Dashboard

Each Nexmatic client gets a Nexmatic-branded dashboard running on their own workspace VPS. The dashboard provides:

- Daily activity summary (skill runs, approvals pending, completed flows)
- Pending approvals with per-action WebAuthn signing
- Integration connection management (OAuth consent flows)
- Schema extensions editor (e.g., "add Job ID as optional field on receipts")
- Custom domain management (self-service)
- Brand voice and behavioral contract editor (client-editable tone, triage rules, approval thresholds)
- Usage summary (skill runs, approvals) — **not** token counts or provider names
- Billing history and plan upgrades

The dashboard is Nexmatic's product surface. Clients interact with Nexmatic through this dashboard; they do not interact with Nexaas directly.

---

## 4. Pricing and Billing Model

Nexmatic bills clients on a **subscription + usage model**, abstracted from provider costs.

### 4.1 What Clients Pay For

- **Workspace subscription**: a recurring fee for their private VPS, framework runtime, base agent bundles, dashboard, and ongoing maintenance
- **Usage allowances**: skill runs per month, approvals per month, or integration events per month — unit depends on the plan
- **Optional premium features**: additional agent bundles, priority support, custom flow authoring, extended retention

### 4.2 What Clients Do NOT See

- Token counts
- Provider names (Anthropic, OpenAI, self-hosted)
- Model names (Opus, Sonnet, Haiku, GPT-4o)
- Per-call cost breakdowns
- Fallback events between providers

Nexmatic absorbs all provider cost variance. When Claude is up, clients pay for skill runs. When Claude has an outage and runs fall back to OpenAI, clients still pay for skill runs at the same price. If a self-hosted local LLM serves some calls for near-zero cost, clients still pay for skill runs at the same price. The abstraction is total: clients are paying for automation outcomes, not for model tokens.

### 4.3 Nexmatic-Internal Cost Management

Token-level data, provider attribution, daily cost caps, and fallback events are all visible to Nexmatic ops in the Ops Console. Nexmatic uses this data for:

- Margin protection (daily cost caps per workspace as internal guards, not client-facing limits)
- Provider contract negotiation
- Model tier efficiency tuning
- Provider health monitoring
- Plan right-sizing ("this client has outgrown their tier")

The daily cost cap is an internal alert, not a client feature. When a workspace approaches its cap, ops decides whether the client has outgrown their plan (raise it and discuss upgrade), whether a skill is misbehaving (fix it), or whether external conditions are causing abnormal cost (absorb or escalate).

---

## 5. The Organic Buildout Model

Nexmatic does not ship with a pre-built library covering every possible flow. Instead, the library grows **organically** as real clients onboard and their needs drive skill and flow creation.

### 5.1 How a Client Comes Online

1. **Client signs on.** Ops creates the client account in the Ops Console, which provisions a VPS, deploys Nexaas runtime + Nexmatic library, and configures DNS for the default `<workspace>.nexmatic.ca` subdomain.

2. **First flow discussion.** Ops and the client discuss the client's most urgent automation need. The client describes what they want in business terms.

3. **Factory interview.** Ops opens the client VPS terminal (via Tailscale jump host or the Ops Console terminal), runs `/new-flow` or `/new-skill`, and walks through the authoring interview. The factory queries Nexmatic's library via RAG to suggest reuse from prior client work.

4. **Flow construction.** The factory generates skill manifests and prompts based on the interview. Ops reviews, tests, and iterates. New MCP capabilities are added if the integration doesn't exist yet; new channels are built if needed; new schema extensions are declared on the client's contract.

5. **Contribution.** When the flow is working, the factory pushes contributed skills, MCPs, and archetypes back to Nexmatic's library with proper versioning and genealogy. Contributions are marked experimental until a curator (initially Al, eventually a curation process) reviews and promotes them.

6. **Soak and iteration.** The flow runs in production. Client feedback drives refinements. `SKILL_IMPROVEMENT_CANDIDATE` markers from the model surface suggested improvements automatically.

### 5.2 Cross-Pollination

When the next client onboards with a similar need, the factory's RAG retrieval finds the prior work and suggests reuse or forking. The second build is faster than the first because the library has grown. Improvements discovered during the second build can propagate back to the first client as **proposals** — never automatic updates, always ops-reviewed before push.

This organic cross-pollination is what makes Nexmatic economically viable at scale. The first client gets a hand-crafted flow. The tenth client with a similar need gets the same flow near-instantly because the library already contains the primitives.

### 5.3 Library Curation

Growing a library through organic contribution without discipline produces a junk drawer. Nexmatic's curation process:

- New contributions are marked `stage: experimental`
- Curators periodically review experimental contributions and either promote them to canonical (with generalized interfaces), merge them into existing canonical skills as variants, or reject them with notes
- Canonical skills have conformance tests and are pinned to specific interface versions
- Client-specific customizations live as workspace schema extensions, NOT as patches to canonical skills

Initially, Al is the sole curator. As the library grows, curation becomes a dedicated responsibility — either a dedicated ops team member, or eventually AI-assisted tooling that suggests merges and flags duplicates for review.

---

## 6. Operator Model

### 6.1 Roles

- **Ops admin**: full authority, enrolls other operators, manages fleet, curates library, signs privileged actions at Tier 1 or Tier 2
- **Ops member**: subset of authority, focused on client support and flow authoring, signs privileged actions at Tier 2
- **Client admin**: authority over their own workspace only, approves waitpoints, edits their own contract, enrolls at Tier 2 passkey at first login
- **Client viewer**: read-only access to their own workspace, cannot approve or edit

Role definitions live in the framework. Nexmatic defines which roles are active in its deployment.

### 6.2 Signing

All privileged actions are signed. Ops uses Tier 1 (file-based key) or Tier 2 (WebAuthn) depending on seniority and context. Clients use Tier 2 exclusively, enrolled at first dashboard login via a recovery-backed enrollment flow.

Every signed action writes a signed WAL row with the operator identity, the signed payload, and the signature. Verification runs bi-daily incremental + weekly full-chain, with results surfaced in the Ops Console.

### 6.3 Privileged Action Categories (Nexmatic)

Nexmatic adds its own privileged action categories on top of the framework's defaults:

- Client onboarding (who signed a client up)
- Plan changes (who authorized a billing upgrade)
- Custom domain approvals (who authorized a non-standard domain)
- Library contribution promotion from experimental to canonical
- Major-version skill propagation to a running client workspace

---

## 7. Onboarding a New Client

### 7.1 Prerequisites

Before a new client can be onboarded:

- The client has been sold on the Nexmatic offering and signed the service agreement
- The client's identification, business information, and contact details have been collected
- The client has designated at least one client admin who will enroll a passkey

### 7.2 Provisioning Steps

1. **Account creation.** Ops signs into the Ops Console, clicks "New Client," enters the client's information, selects the plan tier.

2. **VPS provisioning.** The Ops Console invokes Nexmatic's provisioning scripts, which call Nexaas's `deploy-instance.sh`. This provisions a VPS, installs the Nexaas runtime, deploys the Nexmatic library, and configures the default `<workspace>.nexmatic.ca` subdomain with auto-TLS via Caddy.

3. **Workspace manifest creation.** A starter manifest is generated from a template, with placeholder capability bindings and channel bindings that ops fills in during the first integration setup.

4. **Client admin enrollment.** The client admin receives a one-time enrollment link signed by ops. They visit the link, enroll a passkey, and are now authenticated to their workspace dashboard.

5. **First flow.** Ops and the client discuss the first automation need, and the factory builds it. This is the first real test of the organic buildout model for this client.

6. **Ongoing engagement.** As the client identifies new needs, ops runs the factory again to add skills, flows, or MCPs. The library grows. The client's workspace accumulates automation coverage.

### 7.3 Target Time

- **Simple first flow** (matches an existing library pattern): minutes to hours
- **Medium first flow** (new variation of an existing pattern): hours to a day
- **Complex first flow** (entirely new domain, new MCPs needed): day to several days

These targets assume a productive factory experience and healthy library state. Early clients will take longer because the library is smaller.

---

## 8. Infrastructure

### 8.1 Fleet Layout

- **Ops VPS (nexmatic-main)**: runs the Ops Console, the canonical library, the propagation pipeline, monitoring collectors. Reached via Tailscale by ops. Does NOT run client workloads.
- **Workspace VPSes**: one per client. Each runs a complete Nexaas install: Postgres (with pgvector), Redis (for BullMQ), MCP servers, Claude SDK, client dashboard, Caddy, pillar pipeline runtime. Each has its own public IP and serves its own client dashboard on its own subdomain (or custom domain).
- **Private LAN**: hub-and-spoke connecting the Ops VPS to each Workspace VPS. Used for ops traffic only: monitoring, deploys, library sync, troubleshooting. Client data never traverses this LAN.

### 8.2 Platform Secrets

Nexmatic maintains a sops-encrypted platform secrets file on the Ops VPS:

- `ANTHROPIC_API_KEY` (shared across all clients, usage billed to Nexmatic)
- `VOYAGE_API_KEY` (embedding model)
- `PLAID_CLIENT_ID`, `PLAID_SECRET` (one Nexmatic-registered Plaid app, per-client OAuth)
- `QBO_CLIENT_ID`, `QBO_SECRET` (one Nexmatic-registered QBO app)
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_SECRET`
- `M365_CLIENT_ID`, `M365_CLIENT_SECRET`
- SMTP credentials, Resend API keys
- Any other platform-wide credentials

Secrets are decrypted at deploy time and pushed to each client VPS as `/opt/nexaas/.env.platform` (chmod 600, root-owned). Rotation is done by editing the encrypted file and fleet-wide push.

### 8.3 Per-Client Secrets

Per-client OAuth tokens, API keys, and other client-specific credentials live in the client's local Postgres in `integration_connections` (encrypted with a per-VPS master key), managed by the client dashboard's OAuth flows. These never leave the client's VPS.

### 8.4 Backup and Recovery

- **Postgres** backed up nightly per VPS to ops-managed offsite storage
- **Redis** RDB snapshots taken hourly on each VPS, retained for 7 days
- **Palace WAL** is tamper-evident via hash chain; backup + WAL verification provides integrity proof
- **Recovery testing** performed quarterly on a representative workspace

(Detailed backup strategy is v1.1 work; v1 ships with basic nightly Postgres dumps.)

---

## 9. Client Touchpoints

Each client interacts with Nexmatic through:

- **Their dashboard** (`<workspace>.nexmatic.ca` or custom domain): primary product surface, approvals, configuration, activity, billing
- **Their registered channel adapters**: Telegram, email, Slack, or other channels ops configured for them
- **Ops support contact**: for issues, new flow requests, or upgrades
- **Billing portal**: integrated with the dashboard, shows usage and invoices

Clients do NOT interact with:
- Nexaas primitives directly
- The Ops Console (that is ops-only)
- Other clients' workspaces (strict isolation)
- The canonical library (they consume it, they don't author it)

---

## 10. Reference Use Cases

These are illustrative, not committed. Real v1 flows are authored organically as real clients engage. The organic buildout model means specific flows are not predetermined.

**Accounting Agent — transaction matching.** Daily bank transaction pulls trigger per-transaction matching against QBO entries with receipt attachment from Paperless. Amounts above a configurable threshold route to the client admin for approval, everything else auto-executes with audit trail.

**Marketing Agent — social creative approval.** Weekly creative drafts generated using brand voice stored in the palace, with per-post approval via the client dashboard. Rejected drafts regenerate with feedback. Approved drafts schedule through an integrated social platform.

**Onboarding Agent — new customer intake.** Form webhook triggers multi-step onboarding: document collection, approval gates, provisioning tasks. Each step's state lives in the palace; waitpoints hold the flow while humans complete required steps.

**Receipt Intake — Telegram or Dashboard.** Clients submit receipts via Telegram or dashboard upload. OCR extracts fields, confirms with the user, saves to Paperless, and later matches against Plaid-pulled transactions in QBO.

These are examples of the kind of work Nexmatic's library will contain as it matures. None of them are pre-built as of v1 launch; they emerge from real client needs.

---

## 11. Scaling Model

Nexmatic's economics depend on three things:

1. **Per-client infrastructure costs are covered by client subscription.** Each new client adds a VPS, and the subscription fee includes VPS + maintenance + library access. Infra grows with revenue.

2. **Library leverage makes new clients cheaper over time.** The first client in a functional domain takes significant ops time; the tenth in the same domain takes minimal ops time because the library contains the primitives. Library reuse is the leverage that lets Nexmatic scale to many clients without proportional ops headcount.

3. **Framework stability reduces maintenance overhead.** Because the Nexaas framework is shared across all clients, framework-level improvements benefit everyone simultaneously. Ops invests in framework quality once; all clients benefit.

Target scaling curve:
- End of 2026: 10-25 clients
- End of 2027: 75-100+ clients
- Long-term: hundreds of clients

At hundreds of clients, Nexmatic's moat is the library — years of curated, proven, improvement-cycled skills that cover a broad surface of SMB automation needs. Competitors would need to either rebuild the framework (months of work) or rebuild the library (years of client engagement). The library is the accumulated commercial asset.

---

## 12. Reading Order for Nexmatic Operators

If you are joining Nexmatic ops and need to get productive:

1. This document (`nexmatic.md`) — understand the business
2. `architecture.md` — understand the framework you're building on
3. `glossary.md` — vocabulary reference
4. `v1-refactor-plan.md` — the current execution plan
5. The Nexmatic library structure (once it exists) — what skills and archetypes are available
6. The Ops Console user guide (once written) — how to operate the fleet
7. A live client workspace (via Tailscale jump) — see how a real install looks
8. The factory interview transcripts from prior authoring sessions — learn by example

---

## 13. Risks and Constraints

**Ownership structure.** Nexaas is owned by Al personally, licensed to Nexmatic perpetually and unconditionally. Nexmatic does not own Nexaas. If Al separates from Nexmatic, Nexmatic retains its license but loses the ongoing development relationship with the framework owner. This should be clarified with Nexmatic stakeholders as a known structure.

**Claude dependency.** Nexmatic is built with Claude as its primary model, and the library's skill prompts are tuned for Claude's capabilities. The model gateway provides provider-agnostic fallback, but quality may degrade on non-Claude providers for brand-sensitive or complex tasks. Nexmatic's risk management includes fallback quality monitoring and explicit flags when non-Claude providers are used for high-stakes outputs.

**Library curation bandwidth.** Growing a library organically requires active curation. Initially performed by Al, this responsibility needs either additional ops capacity or AI-assisted tooling as the library grows. Without curation, the library accumulates duplicates and drift, eroding leverage.

**MCP maintenance surface.** Every integration Nexmatic supports is an MCP server that needs maintenance. Third-party API changes, OAuth flow updates, and vendor deprecations all land as Nexmatic ops work. The MCP maintenance burden scales with the number of supported integrations.

**Per-client customization vs. library purity.** Clients will want customizations (the Job ID field example). Nexmatic must discipline the line between workspace schema extensions (per-client) and library changes (canonical), or the library will either stagnate (unable to absorb improvements) or contaminate (client-specific cruft in the canonical version).

---

## 14. Framework vs. Business Restatement

Nexaas is the framework: palace, pillars, capabilities, agents, skills, sub-agents, triggers, channels, contracts, WAL, signing, model gateway, factory primitives, operator console core.

Nexmatic is a business built on Nexaas: library, agent bundles, MCP implementations, factory slash commands, ops console application, client dashboard, pricing, onboarding, curation, branding.

One framework. Many potential businesses could consume it. Nexmatic is the first and primary consumer. Phoenix Voyages and Systemsaholic are also consumers under separate license grants. Other consumers may emerge.

Nexmatic depends on Nexaas. Nexmatic does not control Nexaas. Nexaas changes on a framework release cadence; Nexmatic consumes specific versions at specific times; framework improvements flow to Nexmatic the way they flow to any other Nexaas consumer.
