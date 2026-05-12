# RFC 0002 — PA-as-Router: Multi-Thread User Conduit

**Status:** Proposed
**Authored:** 2026-05-12 (Phoenix canary)
**Owners:** Phoenix Voyages (canary), Nexaas core
**Targets:** `@nexaas/runtime` (notifications-dispatcher #40, inbound-dispatcher #39, waitpoint-resolver, new `/api/pa/<user>/notify` endpoint), `@nexaas/palace` (schema), `@nexaas/manifest` (Zod), `@nexaas/cli` (register-skill), telegram-mcp (Forum/Topics)

---

## 1. Problem

User PAs are single-thread. Each PA reads a linear conversation history per user and replies in the same single chat surface. **Other skills bypass the PA** and write notifications directly to the user's Telegram channel via `notifications/pending/telegram` with a `channel_role` tag. As PAs become the primary UI for the business, this produces two failure modes that compound:

### 1.1 Cross-system context collision

A user mid-conversation about Accounting receives a Telegram alert from a different domain (HR onboarding, lead offer, supplier reply), taps a quick reply, and the PA — which **never saw the external alert** — interprets the reply as continuing the prior thread.

Phoenix observed this 2026-05-11. Mireille's PA was in a deposit-lookup conversation; ~9 hours later an inbound landed about an unrelated topic ("Module 5 for the agent profile link, Isabelle…"). The PA's CAG loaded only the prior deposit context (no awareness of any cross-system alerts she'd received in between) and replied with stale deposit results. She typed `/clear` and restarted.

The bleed was made worse by a workspace-level misconfiguration (covered separately, RFC-adjacent), but the **architectural root cause** is independent: a single linear chat per user, with multiple uncoordinated publishers, has no thread structure for the PA to reason about.

### 1.2 No surface ownership

The PA cannot enforce formatting, urgency policy, dedup, or thread membership on messages it didn't generate. The user-facing surface is composed by N skills with no coordination layer. Mireille's Telegram looks like an unsorted activity feed.

### 1.3 Scale implication

Phoenix is moving toward PAs as the primary UI for 19 users (3 team PAs today; 16 advisor PAs planned). Sixteen advisors × N publishing skills × no thread structure = unrecoverable. The fix has to land at the framework level before ITA rollout.

## 2. Proposal

Two coupled changes:

1. **PA-as-router**: All outbound to a user flows through that user's PA via a new framework endpoint `POST /api/pa/<user>/notify`. The notifications-dispatcher (#40) deprecates the direct `channel_role: pa_notify_*` path in favor of routing through PA. **Skills no longer choose the surface or formatting.**

2. **Domain-scoped threads**: Each PA owns a small fixed set of long-lived threads (e.g. `hr`, `accounting`, `marketing`, `operations`, `personal`) declared per PA profile. Every notification declares its `thread_id`. Inbound from the user is routed back to the originating thread via Telegram `reply_to_message_id` + `message_thread_id` (explicit) with semantic inference as fallback.

## 3. Design

### 3.1 Schema (palace)

**Why `thread_id` is column-level, not content-level.** #56 moved `run_id` out of room names into drawer content because room names are semantic categories, not identifiers. `thread_id` reverses that direction — it becomes a first-class column on `events`. The rationale is JOIN/filter frequency: every PA inbound classification, every inbox-by-thread query, every per-thread digest rollup, and every cross-skill thread audit reads `WHERE thread_id = $1`. JSON-extract on a content field with that frequency would torpedo planner stats and force per-query parsing. `run_id`, `output_id`, `idempotency_key` etc. stay in content because they're one-per-row identifiers that don't drive query selectivity. `thread_id` is a low-cardinality high-frequency filter key — the column treatment is earned, not inconsistent.

```sql
ALTER TABLE nexaas_memory.events
  ADD COLUMN thread_id text;

CREATE INDEX events_user_thread_idx
  ON nexaas_memory.events (workspace, hall, thread_id, created_at DESC)
  WHERE thread_id IS NOT NULL;

CREATE TABLE nexaas_memory.pa_threads (
  workspace        text NOT NULL,
  user_hall        text NOT NULL,                -- e.g. "<user_handle>"
  thread_id        text NOT NULL,                -- e.g. "hr"
  display_name     text NOT NULL,                -- "👥 HR"
  status           text NOT NULL DEFAULT 'active', -- active|paused|closed
  channel_target   jsonb,                        -- {telegram:{chat_id,topic_id}}
  opened_at        timestamptz DEFAULT now(),
  last_activity    timestamptz DEFAULT now(),
  notification_count integer DEFAULT 0,
  PRIMARY KEY (workspace, user_hall, thread_id)
);

CREATE INDEX pa_threads_user_active_idx
  ON nexaas_memory.pa_threads (workspace, user_hall, status)
  WHERE status = 'active';
```

Threads themselves are declared per-PA in the persona profile, **not** in skill manifests — they describe the *user*, not the *publisher*:

```yaml
# agents/pa/sub-agents/<user_handle>/profile.yaml
threads:
  - id: hr
    display: "👥 HR"
    domain_aliases: [hr, recruitment, onboarding, advisor]
  - id: accounting
    display: "💰 Accounting"
    domain_aliases: [accounting, billing, stripe, plaid, quickbooks, reconciliation]
  - id: marketing
    display: "📣 Marketing"
    domain_aliases: [marketing, campaigns, social, ads, seo, content]
  - id: operations
    display: "⚙️ Operations"
    domain_aliases: [operations, infra, monitoring, dns, server]
  - id: personal
    display: "🏠 Personal"
    domain_aliases: [personal, reminders, calendar]
```

`domain_aliases` are hints for the inference fallback (3.4) — not enforcement.

### 3.2 Routing endpoint

New runtime-served HTTP endpoint:

```http
POST /api/pa/<user>/notify
Content-Type: application/json
Authorization: Bearer <NEXAAS_CROSS_VPS_BEARER_TOKEN>   # required when set

{
  "thread_id": "hr",
  "urgency": "normal",                  // immediate | normal | low
  "kind": "alert",                      // alert | approval | digest
  "content": "<advisor> submitted TIPS — review?",
  "content_format": "html",             // html | text | markdown
  "originating_skill": "hr/onboarding-intake",
  "actions": [                          // optional, kind=approval
    {"button_id": "approval:wp-123:approve", "label": "Approve"},
    {"button_id": "approval:wp-123:defer",   "label": "Defer 24h"}
  ],
  "waitpoint_id": "wp-123",             // required when kind=approval
  "idempotency_key": "onboarding:<advisor_id>:tips-submitted", // optional, dedup at ≤1h
  "expires_at": "2026-05-13T00:00:00Z", // optional
  "metadata": { "advisor_code": "<advisor_id>" }
}

→ 202 Accepted
{
  "notification_id": "n-9c4a…",
  "queued": true,
  "estimated_delivery": "2026-05-12T02:15:00Z"
}
```

The PA owns:
- **Rendering** — converts `content` to channel-native format (Telegram HTML escapes, line-length, action button layout)
- **Thread placement** — verifies `thread_id` exists for the user; if classifier flags mismatch (e.g. skill asked `accounting` but content is unambiguously HR), the PA can override and log the override
- **Timing** — applies urgency policy (3.3)
- **Channel target** — looks up `pa_threads.channel_target` for the user+thread, sends to the right Telegram topic
- **Dedup** — if `idempotency_key` matches an unresolved notification ≤ 1 h old, suppress
- **Audit** — every notification gets a drawer in `inbox/<user>/notifications-emitted` with the full payload, the PA's routing decision, and the resolved channel target

**Auth posture.** The endpoint follows the same `bearerAuth()` pattern as `/api/skills/trigger` (#83) and `/api/waitpoints/inbound-match`: when `NEXAAS_CROSS_VPS_BEARER_TOKEN` is set on the worker, requests must present a matching `Authorization: Bearer …` header; when unset (single-VPS direct-adopter), the endpoint is open. Operator-managed deployments (Nexmatic ops-relay → client VPS) **must** set the token. `originating_skill` and `metadata` are caller-asserted; consumers treating them as advisory-only is fine, but signed audit trails should source the originating identity from the bearer token's run context, not the body.

### 3.3 Urgency policy

| Tier | Behavior |
|---|---|
| `immediate` | Render + send to Telegram topic now. Phone buzz regardless of user activity. Bypasses dedup window. |
| `normal` | Land silently in the topic (badge increments, no buzz). Per-topic digest fires every 15 min if backlog ≥ 2 messages; single-item normal events get a delayed buzz at +5 min unless followed by additional traffic on the topic. |
| `low` | Hold for the 7:30 AM morning briefing rollup; never buzzes phone on its own. |

Skill authors make one explicit choice. Defaults discourage `immediate` — manifest registration warns if a skill uses `immediate` on > 20% of its notifications over the trailing week.

### 3.4 Inbound routing (user → thread)

Telegram-adapter writes inbound drawers (unchanged). The inbound-dispatcher (#39) hands them to the PA's `conversation-turn` skill. The PA resolves which thread each inbound belongs to:

1. **Explicit Telegram signals (certain):**
   - `message_thread_id` set (Forum/Topics native) → that thread's topic. Route immediately.
   - `reply_to_message_id` set → look up which thread the replied-to message lived in. Route.

2. **Inference fallback:** PA classifier scores the inbound against `pa_threads` rows where `status='active'`, weighted by:
   - `last_activity` recency (recent thread + similar topic = strong signal)
   - `domain_aliases` keyword overlap with content
   - Currently open `kind=approval` notifications awaiting a yes/no
   - Confidence threshold:
     - `≥ 0.85` → route silently, render reply in that thread
     - `< 0.85` → ask "Looks like you mean HR (<advisor>) — right?" with inline thread chips

3. **Debug/override surface:** every PA reply includes a small "thread: HR" footer (configurable), so the user can verify routing at a glance even when inference handled it silently.

### 3.5 Approval flows (waitpoints)

Approvals route through PA but **the framework's native `resolveWaitpoint` path stays unchanged.** The PA renders inline buttons in the correct thread; the tap goes through `resolveWaitpoint(signal, payload)` as today. A new **shadow drawer** is emitted by the waitpoint-resolver on resolution:

```
wing: notifications, hall: delivered, room: telegram
content: { waitpoint_id, decision, resolved_at, original_notification_id }
```

The PA observes the shadow drawer and logs the decision in-thread:

> *"You approved <advisor> — sent to HR."*

Skill author flow:

```
skill emits approval
  → POST /api/pa/<user>/notify {kind: approval, waitpoint_id, thread_id, …}
  → PA renders inline buttons in HR topic, writes audit drawer
  → user taps "Approve"
  → telegram-adapter resolves waitpoint (framework-native, UNCHANGED)
  → waitpoint-resolver writes shadow drawer (NEW)
  → PA picks up shadow drawer → renders "you approved <advisor>" in HR topic
```

This is the minimal framework change: only the resolver gets a new emit. Approval semantics, button encoding, and waitpoint registry stay identical.

### 3.6 Telegram UX — Forum/Topics

Each PA's chat surface migrates from a private bot DM to a private **supergroup with Forum/Topics enabled**. One topic per declared thread. The user sees a native topic list in the Telegram UI; tapping a topic enters that thread; replies in a topic are inherently scoped.

Per-PA migration (one-time, ~5 min):

1. Bot creates a private supergroup with user + bot
2. Bot enables Forum mode (`setChatPermissions` + `setChatMenuButton`)
3. For each `pa_threads` row, bot creates a topic via `createForumTopic`, stores returned `message_thread_id` in `channel_target.telegram.topic_id`
4. Bot posts a one-line "Moving to threaded UI — old DM archived" notice in the legacy bot DM with a deep link to the new group
5. Legacy DM marked deprecated (PA refuses to send there; if user messages it, PA bot replies once with the migration link)

Fallback mode (`channel_target.mode: "dm_with_chip"`) is supported for users who can't be migrated (e.g. iOS bot DM preferences), with a `[Thread]` chip rendered on each PA message. This mode is maintained as a config flag, not a feature path we invest in.

### 3.7 Inter-PA composition

When PA-A needs PA-B's user's attention, PA-A simply calls `POST /api/pa/<user_b>/notify` — same endpoint as any other skill. PAs interoperate via the framework, not via a special protocol. The `originating_skill` field captures the originating PA's identity for audit (advisory-only; see §3.2 auth posture for trust boundary).

**Cross-VPS topology.** When PA-A and PA-B live on different VPSes (operator-managed Nexmatic mode), this call traverses the same cross-VPS path as `/api/drawers/inbound`: PA-A's runtime calls the ops-relay, which proxies to PA-B's VPS bearer-authenticated. Direct-adopter mode (single VPS per workspace) sees PA-A and PA-B as in-process callers; no relay hop. The endpoint contract is identical either way — adopters don't write topology-aware code.

### 3.8 Channel parity (post-v1)

The endpoint contract is channel-agnostic. Users who prefer email/SMS/3CX can have a `channel_target` per thread of a different kind. Each channel adapter is responsible for its own threading primitive (Telegram → topics; email → subject prefix `[HR]` + List-Id; SMS → no threading, urgency=immediate only). The PA picks rendering per channel. v1 ships Telegram only.

## 4. Migration

Phoenix Voyages is the canary. Phase 1 wires the canary workspace's 3 team PAs on the full schema; Phase 2 generalizes to ~16 advisor PAs (config-only, no schema/framework changes). The framework itself is workspace-agnostic — direct adopters and operator-managed deployments share the same migration path.

### 4.1 Phase 1 checklist

- [ ] Schema: `events.thread_id` column + index, `pa_threads` table
- [ ] Manifest: `@nexaas/manifest` Zod schema for `threads:` in persona profile
- [ ] Runtime: `POST /api/pa/<user>/notify` endpoint + queue + per-thread dispatcher
- [ ] Notifications-dispatcher (#40): deprecate direct telegram path for `pa_notify_*` roles; route through `/api/pa/<user>/notify`
- [ ] Waitpoint-resolver: emit shadow drawer on resolution
- [ ] PA `conversation-turn` skills: thread inference, urgency-aware render, override + dedup logic
- [ ] Telegram-mcp: `createForumTopic`, `sendMessage(message_thread_id)`, `getForumTopicIconStickers` support
- [ ] Telegram-adapter: capture `message_thread_id` + `reply_to_message_id` in inbound metadata
- [ ] Migration script: per-PA group creation + topic seeding + legacy DM redirect
- [ ] Workspace fallback: `dm_with_chip` mode

### 4.2 Backward compatibility

- Existing `notifications/pending/telegram` drawers with `channel_role: pa_notify_*` are **routed through PA** by the dispatcher rather than directly. The drawer schema doesn't change — only the dispatch path.
- Skills calling the new endpoint and skills writing the legacy drawer coexist during rollout. A future RFC can deprecate the legacy form.

### 4.3 Estimated effort

~3 weeks at canary pace, single engineer + Phoenix workspace owner. Telegram Forum migration ceremony per user is ≤ 5 minutes.

## 5. Why not other approaches

| Option | Reason rejected |
|---|---|
| Item-level threads (one per task, e.g. "Onboarding <advisor>") | Unbounded — 20+ active threads on a busy day = unmanageable. Domain threads carry the topic; the PA reasons within the thread. Items can become `metadata` on notifications without needing their own thread. |
| Skills publish to a bus, PA subscribes | More decoupled but PA cannot enforce formatting or block bad senders. PA-as-router gives one render layer, one rate limiter, one audit trail. The bus model is reasonable for *system-to-system* events but not for *system-to-user*. |
| Stay in single Telegram DM with `[Thread]` chip | Maintains the cognitive load that triggered this RFC. Forum/Topics is what Telegram designed for this exact problem; ignoring it forces us to reinvent a worse version. (We keep the chip mode as a fallback, not a primary path.) |
| Approvals stay on direct-render path | Two render layers forever; PA isn't aware of approval state without polling the waitpoint registry. The shadow drawer is a 5-line addition; keep one path. |
| Context-aware urgency holding | Adds reasoning complexity (PA judges when to hold across threads). With Forum/Topics, the topic itself provides "context awareness" — the user can leave a topic muted while working in another. Easy to add later if a real gap emerges. |

## 6. Risks

- **Telegram API quirks**: Forum/Topics is only available on supergroups; private bot DMs cannot be upgraded in place. Migration is structurally a chat replacement, not an upgrade. (Mitigation: scripted one-time migration; clear "we're moving" notice in the legacy DM.)
- **Inference confidence calibration**: the 0.85 threshold is a guess. Phoenix canary should log every routing decision for the first ~2 weeks and tune.
- **Cost regression**: PA renders every outbound (vs skills writing rendered Telegram HTML directly today). Adds ~$0.01–0.05 per notification at Sonnet. Mitigation: kind=alert with simple content skips Sonnet — the PA's render layer is a deterministic transform unless the skill explicitly requests a "natural-language phrasing" mode.
- **Endpoint as single point of failure**: if `/api/pa/<user>/notify` is down, all outbound stalls. Mitigation: queue persistence in BullMQ (same durability as existing notifications-dispatcher); health-check + alert wired into ops dashboard.

## 7. Out of scope (deferred to follow-up RFCs)

- Email/SMS/3CX channel adapters
- User-defined custom threads (`/pa thread new "Wedding"`)
- Cross-workspace PA federation
- PA-side rate limits across all publishing skills (probably needed eventually)
- Admin UI for managing thread membership, urgency overrides, mute/snooze per thread

## 8. Open questions

1. **Should `personal` thread be optional per PA?** Some users may not want a Personal thread (e.g. a fully task-scoped advisor PA). Leaning yes-optional, default-included for team PAs.
2. **What's the right default urgency?** Probably `normal`. Worth checking against the actual distribution of notifications Phoenix sends today.
3. **Topic emoji/icons**: Telegram supports per-topic icon stickers. Set per-PA or per-thread? Likely per-thread, declared in profile.
4. **Thread persistence across PA restarts**: `pa_threads.channel_target` survives — but if a Telegram topic is deleted out-of-band by the user, the PA needs a recovery path (recreate + warn).
5. **Multi-user shared threads** (e.g. two users both in an "Operations" thread together): out of scope for v1 but the schema doesn't preclude it.
6. **Inbound classifier rate/cost cap.** §3.4 fallback hits the model on any inbound lacking `message_thread_id` and `reply_to_message_id`. Need (a) per-user-per-minute rate cap on classifier calls, (b) a hash-based `domain_aliases` keyword pre-filter that short-circuits the LLM when overlap is unambiguous. Worth measuring before Phase 1 lands so we know the steady-state cost regression.
7. **Immediate-usage warning: registration gate or runtime watchdog?** §3.3 mentions warning skills that use `immediate` on > 20% of notifications. `nexaas register-skill` doesn't currently query WAL. Leaning watchdog (analogous to silent-failure / output-staleness watchdogs) so the surface is observable in `notifications.pending.ops-alerts` rather than blocking registration.
8. **Migration-script ownership.** The §3.6 Telegram Forum/Topics migration (bot creates supergroup, enables Forum mode, seeds topics) — does that ship as framework code, as Nexmatic operator-managed tooling, or as workspace-side ops? Framework should own `channel_target` opacity; the actual bot script likely lives workspace-side. RFC should be unambiguous before the implementation issue gets opened.

## 9. Rollout

1. **Land schema + endpoint + Forum/Topics primitives** behind a workspace flag (`pa_routing: v2`)
2. **Wire the canary workspace's 3 team PAs** with `v2` enabled; legacy `v1` still works for all other workspaces
3. **Two-week canary observation**: routing decisions logged, inference accuracy measured, urgency distribution validated
4. **Lift flag to default** once canary is stable; document migration for other workspaces
5. **Phase 2** (workspace-side): the canary adds ~16 advisor PA configs on the same framework (no code, just YAML)
