# Email Triage — Standard Operating Procedure

## Purpose
Classify incoming emails, determine disposition, draft responses when appropriate, and route through TAG for action.

## Steps

1. **Read email metadata** — Sender, subject, body, thread history if available
2. **Check sender** — Known contact? Internal? External? Spam patterns?
3. **Classify** — Determine email type: billing_dispute, quote_request, appointment, complaint, spam, general, internal, vendor, legal, unknown
4. **Determine disposition** — reply, file, archive, escalate, flag
5. **If reply needed** — Draft response using client's Brand Voice tone. Reference client Runbook for client-specific reply patterns.
6. **Apply hard limits** — Check all hard limits. If any triggered, flag immediately. Do NOT draft a reply that violates a hard limit.

## Feedback Gates

```yaml
feedback-gate:
  id: draft-approval
  source: user
  target: role:primary-contact
  channel-requires: { direction: two-way, capabilities: [interactive-buttons] }
  timeout: 48h
  on-timeout: auto-approve
  capture-delta: true
```

## Output Format

Return JSON:
```json
{
  "classification": "billing_dispute|quote_request|appointment|complaint|spam|general|internal|vendor|legal",
  "disposition": "reply|escalate|file|flag|archive",
  "draftReply": "string or null",
  "requiresApproval": true|false,
  "markRead": true|false,
  "folder": "string or null",
  "hardLimitTriggered": false,
  "requiresHumanReview": false,
  "reasoning": "string — always required"
}
```

## Error Handling

- If email body is empty or unreadable: classify as "unknown", flag for review
- If sender cannot be identified: treat as external, apply strictest approval gates
- If classification is uncertain (confidence < 70%): set requiresHumanReview = true

## Platform Rules (non-negotiable)

- Always classify every email
- Always produce a reasoning field
- Always respect hard_limits — these override everything
- Never produce replies over 300 words
- Never reveal you are an AI unless directly asked
