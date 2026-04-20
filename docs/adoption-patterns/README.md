# Adoption Patterns

Distilled framework-usage patterns lifted from canary adoption. Each pattern
answers a concrete *"how do I do X with Nexaas?"* question from an adopter's
perspective, with tenant-agnostic primitives and cross-references into the
framework code.

> **These are not tutorials for specific tenants.** No workspace IDs, no
> chat IDs, no client-specific skill names. When a pattern cites a real-world
> validation, it names the canary (Phoenix Voyages) — the pattern itself is
> always workspace-agnostic.

## Who this is for

- **Direct adopters** (Phoenix Voyages, Systemsaholic's other clients) — turn-key
  patterns for standing up common flows.
- **Operator-managed deployments** (Nexmatic) — reference implementations for
  MCPs and skills to publish in the operator's library.
- **Framework contributors** — patterns surface where the framework is clean
  vs. where it has rough edges; feedback flows back into architecture refinement.

## Authorship discipline

Patterns are written by observing **adopter feedback signals** — GitHub issue
threads, framework commit history, direct triage dialogue. **Not by reading
adopter repo code.** Tenant data stays in tenant repos; these docs describe
framework abstractions.

Each pattern is drafted after a canary validates it. Sections that remain
speculative until live validation are marked *(pending canary validation)*.

## Index

| Pattern | Status | Description |
|---|---|---|
| [`telegram-channel.md`](./telegram-channel.md) | v0.1 — framework-side shipped, Phoenix validation pending (#42) | Inbound + outbound Telegram adapter using v0.2 messaging capabilities; end-to-end approval round-trip |
| `2fa-code-intercept.md` | *pending* | Channel-agnostic one-time-code capture via the inbound-match waitpoint primitive (OAuth, TD MFA, 2FA flows) |
| `approval-gated-output.md` | *pending* | TAG `approval_required` routing for ai-skill outputs — skill author → TAG → channel → human → resume |
| `daily-automation-skill.md` | *pending* | Shell skill with cron trigger + preflight gate + output verification |
| `ai-skill-migration.md` | *pending* | Converting Trigger.dev / n8n / `claude --print` automations into proper Nexaas ai-skills via `/nexaasify` |
| `manifest-hygiene.md` | *pending* | Workspace manifest gotchas (chat_id int/str, channel_role naming, `capability_bindings` vs `channel_bindings`) |
| `debugging-playbook.md` | *pending* | Common symptoms → diagnostics → fixes, indexed by WAL op and SQL query |

## Cross-reference conventions

Every pattern doc includes:

- **Required primitives** — what framework pieces the pattern depends on
  (with file path pointers into `packages/runtime/src/...`)
- **Manifest shape** — the workspace / skill manifest fragments needed
- **Observation path** — which WAL ops fire at each stage + SQL to query
- **Known limits** — what doesn't work yet (linked to open issues)
- **Rollback story** — how to back out if a pattern misbehaves

## Contributing a pattern

After a canary validates a pattern:

1. Issue author (or framework team) files a PR adding a new `*.md` under this directory
2. Pattern follows the template above; tenant specifics are generalized
3. Canary owner reviews for accuracy ("did we capture the gotcha?")
4. Lands on `main`
5. Referenced from `docs/README.md` index table
