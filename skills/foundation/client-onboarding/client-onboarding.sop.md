# Client Onboarding — Standard Operating Procedure

## Purpose

Run a guided interview with the client (or ops on their behalf) to generate all identity documents, behavioral contracts, and channel registry entries for a new Nexaas instance.

## Interview Areas

### 1. Business Identity
- What does the business do?
- Industry/domain?
- How many employees?
- Key people and their roles?

### 2. Brand Voice
- How does the business communicate? Formal? Casual? Industry-specific?
- Any words or phrases to always/never use?
- What's the signature style for emails?
- Examples of communications they're proud of?

### 3. Department Operations (for each active department)
- What does this department handle day-to-day?
- What are the top 3 priorities?
- What should the AI handle vs escalate to a human?
- Who are the key contacts for this department?
- Any department-specific rules or exceptions?

### 4. Agent Handbook
- What are the non-negotiable rules?
- Any lessons learned from past mistakes?
- Business hours?
- Cultural values that should guide decisions?

### 5. Contracts
- Which actions need approval before executing?
- Which actions can run automatically?
- What should NEVER be automated?
- Who gets escalations for financial, legal, complaints?
- What are the hard limits (things the AI must never do)?

### 6. Channels
- How does the owner/manager prefer to be reached? (email, SMS, WhatsApp, Slack, dashboard)
- Different preferences per person?
- What's the preferred notification style? (every action, digest, urgent only)

### 7. Integrations
- What business tools do they use? (Gmail, Wave, QuickBooks, Stripe, etc.)
- What do they want the AI to access?

## Output

The interview produces:
1. `brand-voice.md` — written to `/opt/nexaas/identity/{workspace}/`
2. `{dept}-operations.md` — one per active department
3. `agent-handbook.md` — business culture and rules
4. Behavioral contract YAML — approval gates, escalation rules, hard limits
5. Data contract YAML — enabled integrations and scopes
6. Channel registry entries — at least email + dashboard
7. User channel preferences — per key person
8. List of active departments for HEARTBEAT provisioning

## Feedback Gates

None — the Foundation Skill is a one-time setup conversation.
The outputs are reviewed by the operator before activation.
