# Spend Governance — per-workspace daily AI budget

*Shipped for #215 (production hardening T3, umbrella #219).*

Per-run guardrails (#25: `max_spend_usd`, token caps, turn caps) bound a single
run. Nothing bounded a workspace's *day* — 500 cheap runs at $0.40 each are
invisible to per-run caps. In operator-managed deployments the model keys
belong to the operator, so a runaway day burns the operator's margin directly.

The daily budget is a **hard stop**: when a workspace crosses it, the skill
queue pauses until local midnight. Not an advisory alert.

## Configuration

```
nexaas config set spend-budget 25        # $25/day hard budget
nexaas config set spend-budget off       # back to unlimited (the default)
nexaas config set spend-override today   # disable enforcement for today only
```

- Budget lives in `nexaas_memory.workspace_config.spend_daily_budget_usd`
  (NULL = unlimited — every existing workspace is unaffected until opted in).
- The budget day is the **workspace-local day** (`workspace_config.timezone`),
  so "resumes at midnight" matches the operator's clock.
- The override is a one-day escape hatch stored in `workspace_kv`
  (`spend_budget_override_date`); it expires naturally at day rollover.

## How it works

**Recording.** The agentic loop (every ai-skill and PA conversation) and the
model gateway (pillar-pipeline path) upsert completed-call cost into
`nexaas_memory.spend_daily (workspace, day)`. Recording never throws — an
accounting failure must not fail a run that already happened.

**Enforcement** is deliberately *not* per-turn. Spec'd behavior: in-flight
runs finish their current step and park. Overshoot is bounded by
`worker concurrency × max_spend_usd`.

| Surface | Behavior on breach |
|---|---|
| ai-skill (pre-run, after preflight) | Run is **skipped** (not failed — no silent-failure counter pollution), terminal drawer written, queue paused immediately |
| Model gateway (pre-call) | Throws `SpendBudgetExceededError` **before** resolving providers — the fallback chain can never route around the budget onto a still-billable fallback key |
| PA service (pre-conversation) | Returns a clear refusal message naming the override command — PA arrives over HTTP, so the queue pause alone wouldn't stop it |
| Worker monitor (60s tick + at startup) | Pauses/resumes the queue persistently |

**Pause/resume is monitor-driven, not timer-driven.** The 429 backoff (#27)
uses in-memory `setTimeout` resumes — fine for 5-minute cooldowns, wrong for
an overnight pause: BullMQ pause state persists in Redis across worker
restarts and the timer doesn't. The spend-budget monitor re-evaluates every
minute (and once at worker startup), so a restarted worker reconciles a stale
pause, day rollover resumes naturally, and the override takes effect within
a minute. The pause marker (`workspace_kv.spend_pause_active_day`) ensures
the monitor only resumes queues *it* paused.

## Observation

```
nexaas health      # "Spend budget: $19.80 of $25.00 (79%)" + warning ≥80%, critical when paused
nexaas config      # shows the configured budget
```

| WAL op | When |
|---|---|
| `spend_budget_exceeded` | Queue paused (spent/budget/model-call counts in payload) |
| `spend_budget_resumed` | Queue resumed (reason: override vs rollover/budget change) |
| `ai_skill_skipped` with `spend_budget: true` | A queued run arrived while over budget |

An ops alert (severity critical, deduped per workspace-day) fires on breach
via the unified notification dispatch (Telegram/email/palace).

```sql
-- Spend history
SELECT day, usd, model_calls FROM nexaas_memory.spend_daily
 WHERE workspace = :ws ORDER BY day DESC LIMIT 14;
```

## Limits / notes

- Runs whose tier has no pricing in `model-registry.yaml` record $0 — keep
  pricing populated or the budget undercounts.
- `spend_daily` is framework accounting, not billing truth — reconcile
  against the provider console for invoicing.
- Anthropic-side per-key spend limits remain the backstop (key provisioning
  is operator-side work, tracked in the Nexmatic repo).
