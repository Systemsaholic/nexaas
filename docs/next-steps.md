# Nexaas — Recommended Next Steps

**Date:** 2026-04-06
**Status:** Post-audit action plan
**Baseline:** Architecture compliance score 75/100

---

## What's Working

The platform has a solid foundation. These are production-ready:

- Trigger.dev execution engine with self-healing and failure escalation
- Skill packages with enforced MCP contracts via `executeSkill()`
- Self-improvement loop (feedback → sanitize → propose → approve → propagate)
- Human-in-the-loop approval via Trigger.dev waitpoints
- Ops dashboard (instances, deploy, skills, integrations, terminal)
- Client dashboard with 2FA auth, approvals, activity, skills honing
- OVH VPS creation + Cloudflare DNS + SSL (one-click deploy)
- Health monitoring + hourly maintenance automation
- Instance Claude Code with CLAUDE.md + slash commands

---

## Priority 1: Architecture Alignment (Next Sprint)

These close the gaps between the spec and the implementation.

### 1.1 Define ClientContext TypeScript Interface

**What:** Formalize the CAG context object as a typed interface instead of `Record<string, unknown>`.

**Why:** Every skill receives this context. Without types, developers can't discover what's available. Bugs from typos and missing fields are invisible until runtime.

**Where:** Create `orchestrator/types/client-context.ts`, import in `skill-executor.ts`.

**Fields (from Architecture Guide §3.3):**
```typescript
interface ClientContext {
  // Layer 1 — Behavioral
  tenant: string;
  tenantName: string;
  tone: string;
  domain: string;
  approvalGates: Record<string, string>;
  hardLimits: string[];
  escalationRules: Record<string, string>;
  notificationPrefs: { channel: string; mode: string };

  // Layer 2 — Live state (empty until integrations wired)
  contactKnown?: boolean;
  senderType?: string;
  priorInteractions?: Array<{ date: string; type: string; summary: string }>;
  openInvoices?: Array<{ id: string; amount: number; days: number }>;

  // Layer 3 — Workflow state (empty until populated)
  threadId?: string;
  workflowStage?: string;
  priorDisposition?: string;
  retryCount?: number;

  // Skill input
  input: Record<string, unknown>;

  // RAG (empty until Qdrant integrated)
  ragChunks: Array<{ content: string; source: string }>;

  // Custom rules
  customRules?: string;
}
```

### 1.2 Add Workflow State to CAG (Layer 3)

**What:** Query `activity_log` and `conversation_contexts` during context assembly to give skills memory of prior actions on the same thread/entity.

**Why:** Without this, skills treat every invocation as the first. Email triage can't know "I already sent a reminder 3 days ago." Invoice reminders can't know "this was escalated last week."

**Where:** Add to `buildCagContext()` in `skill-executor.ts`.

**Implementation:**
- Query `activity_log WHERE workspace_id = X AND skill_id = Y ORDER BY created_at DESC LIMIT 5`
- Query `conversation_contexts WHERE thread_id = X` if thread ID provided
- Include as `priorInteractions` and `workflowStage` in ClientContext

### 1.3 Differentiate TAG Routes at Runtime

**What:** The TAG router currently treats `auto_execute` and `notify_after` the same. The spec defines distinct behaviors:
- `auto_execute` → act immediately, no notification
- `notify_after` → act immediately, then notify the client what happened
- `approval_required` → pause, wait for approval (implemented ✓)
- `escalate` → forward to named person
- `flag` → create review task
- `defer` → queue for later (e.g., outside business hours)

**Why:** Without `notify_after`, clients either approve everything (friction) or see nothing (opacity). Without `escalate`, critical issues don't reach the right person.

**Where:** Extend `determineTagRoute()` and add post-routing actions in `skill-executor.ts`.

---

## Priority 2: RAG Integration (Medium Term)

### 2.1 Qdrant Vector Database Setup

**What:** Deploy Qdrant (self-hosted) on each instance. Create namespaced collections per the RAG config.

**Namespaces (from Architecture Guide §4.1):**
- `[tenant]_knowledge` — client's own SOPs, policies, FAQs
- `[skill]_docs` — skill-specific reference material
- `global/[domain]` — platform-wide defaults

**Why:** Skills currently operate without any knowledge base. The email triage skill can't reference the client's communication policy. The bookkeeping skill can't look up their chart of accounts.

### 2.2 Implement retrieveRelevantDocs()

**What:** Function that searches Qdrant with the CAG context, returns top 3-5 chunks.

**Search order:** Client namespace → skill docs → global fallback (cascade strategy already defined in `rag-config.yaml`).

### 2.3 Wire Knowledge Uploads

**What:** The client dashboard's Knowledge tab already uploads files to `/opt/nexaas/knowledge/{skill}/`. These need to be vectorized into Qdrant.

**Flow:** Upload file → extract text → chunk → embed (via Anthropic or local model) → store in Qdrant `[tenant]_knowledge` collection.

---

## Priority 3: Live Integration Adapters (Medium Term)

### 3.1 CAG Layer 2 — Live Client State

**What:** Add adapter functions that fetch real-time data from connected integrations during CAG assembly.

**Adapters needed (per Architecture Guide §3.2):**
- Email adapter (Gmail/IMAP/M365) → known sender, thread history
- Invoice adapter (Wave/QuickBooks/Stripe) → open invoices, payment status
- CRM adapter (Groundhogg) → contact info, tags, pipeline stage
- Calendar adapter (Nextcloud/M365) → availability

**Where:** Create `orchestrator/adapters/` directory with one adapter per integration type.

**Integration with skill-executor:** `buildCagContext()` checks workspace manifest for connected integrations, calls the appropriate adapters, merges into ClientContext Layer 2.

### 3.2 OAuth Token Refresh

**What:** Connected integrations have OAuth tokens with expiry. Need automatic refresh before they expire.

**Where:** `client-dashboard/lib/token-refresh.ts` — background job or on-demand refresh.

---

## Priority 4: Deploy Flow Completeness

### 4.1 Automated Client Dashboard Deployment

**What:** `deploy-instance.sh` currently deploys Trigger.dev + worker but NOT the client dashboard. Manual steps are still needed: install Postgres, build client-dashboard, configure .env, start systemd service.

**Fix:** Add these steps to the deploy script and the OVH provisioning route.

### 4.2 Automated Postgres Setup on Instances

**What:** The deploy script skips Nexaas DB creation when native Postgres isn't installed. Client dashboard and skills need it.

**Fix:** Add `apt-get install -y postgresql` + schema application to deploy flow.

### 4.3 Workspace Manifest Auto-Registration

**What:** When deploying a new instance, the workspace manifest should be created and committed to git automatically. Skills should be auto-registered in `workspace_skills`.

**Current state:** Partially done in the OVH provisioning route. Needs to be in `deploy-instance.sh` too for existing VPS deployments.

---

## Priority 5: Security Hardening

### 5.1 Remaining Medium Fixes

- Rate limiting on login, password change, invite token endpoints
- Timing-safe secret comparison (`crypto.timingSafeEqual`)
- CSRF tokens on state-changing operations
- Content-Security-Policy headers
- Path traversal protection in knowledge file operations
- OAuth state parameter randomization (PKCE)
- Reduce session timeout from 7 days to 2 hours

### 5.2 Audit Logging

**What:** Log all security-relevant events (login attempts, password changes, approval actions, admin access, skill deployments) to a tamper-proof audit table.

### 5.3 Secret Rotation

**What:** Document and automate rotation of:
- ADMIN_SECRET (ops + client dashboards)
- ANTHROPIC_API_KEY
- OVH credentials
- Cloudflare API token
- Trigger.dev secret key
- NEXTAUTH_SECRET
- TOKEN_ENCRYPTION_KEY

---

## Priority 6: Onboarding Automation (Phase 3)

### 6.1 Guided Onboarding Conversation

**What:** Claude-powered chatbot that walks the client through onboarding questions and generates the behavioral YAML contract from their natural language answers.

**Spec reference:** Architecture Guide §9

### 6.2 Self-Serve Signup

**What:** Public website (nexmatic.com) → sign up → payment → auto-deploy VPS → invite email → client sets up account → connects integrations → AI starts working.

**Goal:** Zero human intervention from signup to running workspace.

---

## Blocked Until Architecture Guide Update

The following decisions require an updated Architecture Guide before implementation:

1. **RAG technology choice** — Qdrant (self-hosted) vs. Pinecone (managed) vs. pgvector (Postgres extension)
2. **Embedding model** — Anthropic embeddings vs. local model vs. OpenAI
3. **Live adapter priority** — Which integrations to wire first (email is highest value)
4. **Escalation dispatch mechanism** — Email, SMS, Slack, Telegram, or all?
5. **Approval notification channels** — Dashboard only, or add push notifications/email/SMS?
6. **Multi-user per workspace** — Current model is one user per workspace. Phase 3 may need team access.
7. **Billing model details** — Monthly minimum + per-usage pricing tiers need to be finalized for Stripe configuration.

---

## Summary

| Priority | Items | Timeline |
|----------|-------|----------|
| P1: Architecture Alignment | ClientContext types, workflow state, TAG route differentiation | Next sprint |
| P2: RAG Integration | Qdrant setup, retrieveRelevantDocs(), knowledge vectorization | 2-3 weeks |
| P3: Live Adapters | Email, invoice, CRM adapters in CAG Layer 2 | 3-4 weeks |
| P4: Deploy Completeness | Auto-deploy client dashboard + Postgres + manifest | 1 week |
| P5: Security Hardening | Rate limiting, CSRF, CSP, audit logging | 1-2 weeks |
| P6: Onboarding Automation | Guided conversation, self-serve signup | Phase 3 |
