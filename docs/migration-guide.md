# Nexaas Migration Guide

**Document status:** Canonical reference for migrating existing automation systems to Nexaas
**Last updated:** 2026-04-16

This guide covers migrating a VPS currently running automation workflows on Trigger.dev, n8n, custom cron scripts, or other orchestration systems to the Nexaas framework. The migration is designed to be **incremental, reversible, and zero-downtime** — both systems run side by side throughout, and any flow can revert in under a minute.

---

## 1. Before You Begin

### Prerequisites

- SSH access to the target VPS
- The VPS has at least 1 GB of free RAM beyond current usage (for Nexaas runtime + Redis)
- Postgres is installed on the VPS (Nexaas uses the existing instance)
- The Nexaas ops VPS can reach this VPS over the private LAN
- You have a complete inventory of every automation flow currently running on the source system

### What you need to know about your current system

Before any migration, document:

1. **Every active flow** — name, trigger type (cron schedule, webhook, email polling, manual), what it does in plain English
2. **Every external integration** — which APIs, databases, email accounts, messaging platforms, file systems each flow touches
3. **Every human-in-the-loop point** — where flows pause for approval, what channel the approval comes through, who approves
4. **Every scheduled cadence** — cron expressions, polling intervals, batch windows
5. **Current resource usage** — RAM, CPU, disk consumed by the automation system
6. **What breaks if you stop it** — for each flow, what's the business impact of 1 hour downtime? 1 day?

This inventory becomes your migration checklist. Every item gets migrated, verified, and checked off.

### The golden rule

**Never remove the source system until every flow has been running on Nexaas for at least one full business cycle (typically one week) with no issues.**

The source system is your safety net. It stays running, ready to take back any flow at a moment's notice, throughout the entire migration. Removing it prematurely is the only way this migration causes real damage.

---

## 2. Migration Architecture

### Parallel operation

Both the source system and Nexaas run simultaneously on the same VPS:

```
Your VPS
├── Source system (Trigger.dev / n8n / cron / etc.)
│   ├── All existing flows still active
│   └── Nothing changed, nothing removed
│
├── Nexaas runtime (new, installed alongside)
│   ├── Postgres (palace schema added to existing instance)
│   ├── Redis (new, for BullMQ job queue)
│   ├── BullMQ sandboxed workers
│   └── Flows migrate here ONE AT A TIME
│
└── External systems (email, APIs, databases, etc.)
    └── Accessible by both systems via shared credentials
```

At any moment, each flow runs on exactly one system. Never both — that would cause duplicate processing (duplicate emails sent, duplicate API calls, duplicate database writes).

### The migration cycle for each flow

```
1. PREPARE    → Rewrite the flow as a Nexaas skill
2. DISABLE    → Stop the flow on the source system (don't delete)
3. ENABLE     → Start the Nexaas version
4. VERIFY     → Monitor for one full business cycle
5. CONFIRM    → Mark this flow as migrated
   or
5. REVERT     → Stop Nexaas version, re-enable source version (<1 min)
```

Each flow goes through this cycle independently. Migrating flow #3 has no effect on flows #1, #2, #4, etc. — they stay wherever they currently run.

### Shadow mode for high-stakes flows

Flows that write to external systems (send emails, create accounting entries, post to social media, charge credit cards) should run in **shadow mode** before going live:

- The Nexaas version runs alongside the source version
- Nexaas reads the same inputs and produces outputs, but **does not execute** the side effects
- Instead, it writes its proposed actions to the palace and sends a comparison report to ops
- Ops compares what Nexaas would have done versus what the source system actually did
- Only when the outputs match consistently does the Nexaas version go live

Shadow mode adds 24-48 hours to the migration of each high-stakes flow. Worth it for flows where a mistake costs real money or reputation.

---

## 3. Installing Nexaas Alongside an Existing System

### Step 1: Install Nexaas runtime

From the ops VPS:

```bash
# Install the Nexaas framework packages on the target VPS
ssh ubuntu@<vps-ip> 'npm install -g @nexaas/cli'

# OR if installing from the Nexaas repo directly during v1:
ssh ubuntu@<vps-ip> 'cd /opt/nexaas && npm install'
```

### Step 2: Install and configure Redis

```bash
ssh ubuntu@<vps-ip> 'sudo apt-get install -y redis-server'

# Configure Redis for persistence (RDB snapshots)
ssh ubuntu@<vps-ip> 'sudo tee -a /etc/redis/redis.conf > /dev/null << EOF
save 900 1
save 300 10
save 60 10000
maxmemory 256mb
maxmemory-policy noeviction
EOF'

ssh ubuntu@<vps-ip> 'sudo systemctl restart redis-server'
```

### Step 3: Install pgvector

```bash
ssh ubuntu@<vps-ip> 'sudo apt-get install -y postgresql-16-pgvector'
```

### Step 4: Apply the palace schema

```bash
ssh ubuntu@<vps-ip> 'psql -d nexaas < /opt/nexaas/database/migrations/012_palace_substrate.sql'
```

Verify:

```bash
ssh ubuntu@<vps-ip> 'psql -d nexaas -c "SELECT tablename FROM pg_tables WHERE schemaname = '\''nexaas_memory'\'' ORDER BY tablename"'
```

You should see 15+ tables including `closets`, `embeddings`, `operators`, `ops_alerts`, `skill_runs`, `wal`, etc.

### Step 5: Configure the Nexaas runtime

Create `/opt/nexaas/.env` on the target VPS:

```bash
DATABASE_URL=postgresql://ubuntu:nexaas2026@localhost/nexaas
REDIS_URL=redis://localhost:6379
NEXAAS_WORKSPACE=<workspace-id>
NEXAAS_ROOT=/opt/nexaas
ANTHROPIC_API_KEY=<from-platform-secrets>
VOYAGE_API_KEY=<from-platform-secrets>
```

### Step 6: Install and start the Nexaas worker

```bash
# Create systemd service
ssh ubuntu@<vps-ip> 'sudo tee /etc/systemd/system/nexaas-worker.service > /dev/null << EOF
[Unit]
Description=Nexaas BullMQ Worker
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/nexaas
EnvironmentFile=/opt/nexaas/.env
ExecStart=/usr/bin/node packages/runtime/src/worker.js
Restart=always
RestartSec=5
MemoryMax=6G
MemoryHigh=5G
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF'

ssh ubuntu@<vps-ip> 'sudo systemctl daemon-reload && sudo systemctl enable nexaas-worker && sudo systemctl start nexaas-worker'
```

### Step 7: Verify Nexaas is running

```bash
ssh ubuntu@<vps-ip> 'systemctl status nexaas-worker'
ssh ubuntu@<vps-ip> 'redis-cli ping'
ssh ubuntu@<vps-ip> 'psql -d nexaas -c "SELECT count(*) FROM nexaas_memory.wal"'
```

The worker should be active, Redis should respond PONG, and the WAL should have a genesis row.

At this point, Nexaas is installed and running but handling zero flows. Your source system continues operating unchanged.

---

## 4. Migrating from Trigger.dev

### Understanding the shape difference

| Trigger.dev concept | Nexaas equivalent |
|---|---|
| `task({ id, run })` | Skill manifest (`skill.yaml`) + prompt (`prompt.md`) |
| `schedules.task({ cron })` | Skill trigger: `type: cron, schedule: "..."` |
| `triggerAndWait(subtask)` | Sub-agent invocation or multi-step skill with palace state |
| `wait.createToken` / `wait.forToken` | Palace waitpoint: `createWaitpoint()` / `resolveWaitpoint()` |
| `batchTrigger` | Event-driven composition: skill writes to `events.*` room, subscriber skills fire |
| `idempotencyKey` | Drawer content hash in the palace (built-in dedup) |
| `queue: { concurrencyLimit }` | BullMQ per-key concurrency in workspace config |
| `maxDuration` | Skill manifest timeout + waitpoint timeout policy |
| `logger.info(...)` | Palace drawer write (every log is a drawer in `ops.*` rooms) |

### Rewriting a Trigger.dev task as a Nexaas skill

**Before (Trigger.dev):**

```typescript
export const myTask = task({
  id: "check-inbox",
  queue: { name: "workspace-tasks", concurrencyLimit: 5 },
  run: async (payload) => {
    const session = await createWorkspaceSession(
      process.env.NEXAAS_WORKSPACE!,
      { skillId: "email/inbox-check", threadId: payload.threadId }
    );
    
    const emails = await listUnreadEmails(session);
    for (const email of emails) {
      await processEmail(email, session);
    }
    
    return { processed: emails.length };
  }
});

export const checkInboxSchedule = schedules.task({
  id: "check-inbox-schedule",
  cron: "*/15 * * * *",
  run: async () => {
    await myTask.triggerAndWait({});
  }
});
```

**After (Nexaas skill):**

`skill.yaml`:
```yaml
id: email/inbox-check
version: 1.0.0
description: Poll inbox for unread emails and process each one

triggers:
  - type: cron
    schedule: "*/15 * * * *"

steps:
  - id: poll-and-process
    model_tier: good
    prompt: prompts/inbox-check.md

requires:
  capabilities:
    - email-inbox

rooms:
  primary:
    wing: inbox
    hall: email
    room: unread
  retrieval_rooms:
    - { wing: knowledge, hall: brand, room: voice }

outputs:
  - id: email_response
    routing_default: auto_execute
    overridable: true
    overridable_to: [approval_required]

self_reflection: true
```

`prompts/inbox-check.md`:
```markdown
You are an email processing assistant. Review unread emails in the inbox
and process each one according to the workspace's behavioral contract.

For each email:
1. Read the full thread
2. Determine the appropriate action (respond, escalate, archive)
3. Draft a response if needed, following the brand voice
4. Execute the determined action

## Self-Reflection Protocol
If during this task you determine the current approach is insufficient
or a better method exists, output on its own line:

SKILL_IMPROVEMENT_CANDIDATE: [description]
```

The key differences:
- **No code for scheduling** — declared in the manifest
- **No explicit MCP calls** — the skill declares `requires: capabilities: [email-inbox]` and the runtime resolves the right MCP
- **No explicit state management** — the palace holds all state; drawers are the audit trail
- **No explicit logging** — every action writes a drawer automatically
- **TAG routing is declared, not coded** — outputs declare their routing policy in the manifest

### Rewriting a Trigger.dev waitpoint flow

**Before (Trigger.dev):**

```typescript
const token = await wait.createToken({
  idempotencyKey: `approval-${advisorCode}`,
  timeout: "7d",
});

await sendTelegramApproval(chatId, {
  text: "Approve this advisor?",
  buttons: [
    { text: "Approve", callback_data: `waitpoint:${token.id}:approve` },
    { text: "Reject", callback_data: `waitpoint:${token.id}:reject` },
  ],
});

const result = await wait.forToken<{ approved: boolean }>(token);
```

**After (Nexaas skill):**

The waitpoint is declared in the skill manifest, not coded:

```yaml
outputs:
  - id: advisor_approval
    routing_default: approval_required
    overridable: false
    notify:
      channel_role: approval_gate
      timeout: 7d
      on_timeout: escalate
```

The runtime handles the rest: creates the dormant drawer, notifies through whatever channel the workspace has bound to `approval_gate` (Telegram, email, dashboard — the skill doesn't know or care), and resumes the next step when the approval comes in.

The Telegram bridge (or email handler, or dashboard) calls `resolveWaitpoint(signal, resolution, actor)` when the human responds. The skill's next step receives the resolution via the `resumedWith` parameter.

### Handling Trigger.dev-specific patterns

**`triggerAndWait` chains** (sequential sub-tasks):

In Trigger.dev, you chain tasks with `await subtask.triggerAndWait(payload)`. In Nexaas, this becomes either:

- **Multi-step skill**: one skill with multiple steps in the manifest, each step runs as a separate BullMQ job, state passes through the palace between steps
- **Event-driven composition**: step 1 writes a drawer to `events.step1.completed`, step 2 subscribes to that event room and fires automatically

Multi-step is cleaner for linear chains. Event-driven is cleaner for fan-out (one event triggers multiple downstream skills).

**`batchTrigger`** (fan-out to many tasks):

In Nexaas, this is event-driven composition. The parent skill writes one drawer per item to an `events.*` room. Each subscriber skill has `triggers: [{ type: event, event: "that.room" }]` and fires once per drawer. BullMQ handles the parallelism via per-key concurrency.

**`onFailure` handlers** (self-healing):

In Nexaas, failure handling is built into the runtime. When a step fails, `runTracker` marks the run as failed, the WAL records the failure, and TAG routing can be configured to escalate failures:

```yaml
outputs:
  - id: result
    routing_default: auto_execute
    on_failure: escalate
```

The ops notification system picks up the escalation. No custom `onFailure` task needed.

### Migration checklist for Trigger.dev

For each Trigger.dev task being migrated:

- [ ] Document the task's purpose, schedule, inputs, outputs, and side effects
- [ ] Identify which capabilities the task uses (email, database, API calls, etc.)
- [ ] Identify any waitpoint / approval flows
- [ ] Identify any sub-task chains (`triggerAndWait`, `batchTrigger`)
- [ ] Write the Nexaas skill manifest (`skill.yaml`)
- [ ] Write the prompt (`prompt.md`)
- [ ] Write `task.ts` only if the skill needs custom pre/post logic (most don't)
- [ ] Determine if shadow mode is needed (does this flow write to external systems?)
- [ ] Disable the Trigger.dev schedule for this task
- [ ] Enable the Nexaas skill
- [ ] Monitor for one full business cycle
- [ ] Verify WAL entries are correct
- [ ] Verify palace drawers match expected behavior
- [ ] Check off as migrated
- [ ] If issues: revert by stopping Nexaas skill + re-enabling Trigger.dev schedule

---

## 5. Migrating from n8n

### Understanding the shape difference

| n8n concept | Nexaas equivalent |
|---|---|
| Workflow (visual canvas) | Flow (skill composition in a manifest) |
| Trigger node (cron, webhook, etc.) | Skill trigger declared in manifest |
| HTTP Request node | MCP capability tool call |
| IF / Switch node | TAG routing (policy-driven, not code-driven) |
| Wait node | Palace waitpoint with configurable timeout policy |
| Set / Function node | Claude execution within the pillar pipeline (AI replaces manual data transforms) |
| Error Trigger node | TAG escalation + ops notification |
| Webhook node | Skill trigger: `type: webhook, path: "/hooks/..."` |
| Execute Workflow node | Event-driven composition or sub-agent invocation |
| Credentials | Capability bindings in workspace manifest + integration_connections table |

### The fundamental difference

n8n workflows are **deterministic data pipelines** — "if this, then that, with these transformations." Nexaas skills are **AI-driven context-aware execution** — "given this context and these rules, let Claude decide the best action and enforce policy on the result."

This means n8n migrations often **simplify dramatically** because logic that was hand-coded in n8n nodes (complex conditionals, data transformations, error handling branches) becomes a single Claude prompt that handles the full range of cases. What was 30 nodes in n8n might be one skill with a good prompt.

However, some n8n workflows are genuinely better as deterministic pipelines (simple data sync, scheduled reports with fixed formats, webhook-to-API forwarding with no judgment needed). For these, Nexaas still works (the skill's Claude step can be minimal or even a pass-through), but the value add is the palace audit trail and TAG enforcement rather than AI intelligence.

### Rewriting an n8n workflow as a Nexaas skill

**Example: n8n "New Lead → CRM → Notification" workflow**

In n8n, this is typically:
1. Webhook trigger (form submission)
2. HTTP Request to enrich the lead (Clearbit or similar)
3. Set node to format CRM fields
4. HTTP Request to CRM API (create contact)
5. IF node: lead score > threshold?
6. Yes → Slack notification to sales team
7. No → Email drip sequence

In Nexaas:

`skill.yaml`:
```yaml
id: sales/lead-intake
version: 1.0.0
description: Process new leads — enrich, add to CRM, route to sales or nurture

triggers:
  - type: webhook
    path: /hooks/lead-intake

steps:
  - id: process-lead
    model_tier: good
    prompt: prompts/lead-intake.md

requires:
  capabilities:
    - crm

rooms:
  primary:
    wing: events
    hall: sales
    room: new-leads

outputs:
  - id: crm_entry
    routing_default: auto_execute
    overridable: false
  - id: sales_notification
    routing_default: auto_execute
    notify:
      channel_role: sales_alerts
  - id: nurture_enrollment
    routing_default: auto_execute
```

The prompt handles the enrichment, scoring, and routing decision — all in one step instead of 7 nodes. TAG ensures the CRM write happens according to policy. The palace records every lead processing event for audit.

### Handling n8n-specific patterns

**Credentials management**: n8n stores credentials in its own encrypted database. In Nexaas, credentials live in `integration_connections` (per-client encrypted with per-VPS keys) for OAuth tokens, and in `.env.platform` for platform-wide API keys. During migration, extract each credential from n8n and re-enter it in the appropriate Nexaas tier.

**Error workflows**: n8n has a separate "Error Trigger" workflow that fires when any workflow fails. In Nexaas, failure handling is built into the framework: every step failure writes a WAL entry, updates `skill_runs`, and triggers the ops notification system (Tier B for routine failures, Tier A for critical). No separate error workflow needed.

**Sub-workflows (Execute Workflow node)**: In Nexaas, this maps to either sub-agent invocation (for synchronous delegation within a skill) or event-driven composition (for async triggering of another skill). The pattern depends on whether the parent needs to wait for the child's result.

**Sticky notes and documentation**: n8n workflows are self-documenting via the visual canvas. In Nexaas, documentation lives in the skill's `prompt.md` (what the AI does), `skill.yaml` (what the skill is), and the palace drawers (what actually happened). The audit trail is richer but less visual. The Ops Console provides the visual interface for inspecting runs.

### Migration checklist for n8n

For each n8n workflow being migrated:

- [ ] Export the workflow JSON from n8n (for reference during rewrite)
- [ ] Document the workflow's purpose, trigger, nodes, and side effects
- [ ] Identify which nodes are data transforms vs. judgment calls
- [ ] Identify which capabilities are needed (map n8n credential types to Nexaas capabilities)
- [ ] Decide: does this workflow benefit from AI, or is it a deterministic pipeline?
- [ ] Write the Nexaas skill manifest + prompt
- [ ] Migrate credentials from n8n to Nexaas (integration_connections or .env.platform)
- [ ] Determine if shadow mode is needed
- [ ] Deactivate the n8n workflow (don't delete)
- [ ] Enable the Nexaas skill
- [ ] Monitor for one full business cycle
- [ ] Verify behavior matches or improves on the n8n version
- [ ] Check off as migrated
- [ ] If issues: revert by deactivating Nexaas skill + reactivating n8n workflow

---

## 6. Migrating from Custom Cron Scripts / Systemd Timers

### Understanding the shape difference

If your VPS runs automation via cron jobs, bash scripts, or systemd timers:

| Custom script concept | Nexaas equivalent |
|---|---|
| Cron job (`crontab -e`) | Skill trigger: `type: cron` |
| Bash script | Nexaas skill (AI-driven) or skill with custom `task.ts` (for deterministic work) |
| Systemd timer + service | BullMQ scheduled job with sandboxed worker |
| Log file (`>> /var/log/...`) | Palace drawers (structured, queryable, auditable) |
| PID file / lock file | BullMQ per-key concurrency (no double-execution by construction) |
| Email alerts on failure | Ops notification system (Slack + email, tiered by severity) |

### The migration is usually simpler

Custom scripts are typically self-contained and don't have the framework-level dependencies that Trigger.dev or n8n do. The migration is:

1. Read the script, understand what it does
2. Write a Nexaas skill that does the same thing (often simpler because Claude handles the edge cases the script tried to handle with brittle conditionals)
3. Disable the cron job / systemd timer
4. Enable the Nexaas skill
5. Monitor

The cron expression usually copies directly into the skill manifest's trigger:

```yaml
triggers:
  - type: cron
    schedule: "0 6 * * *"    # same cron expression as the old crontab entry
```

---

## 7. Migration Order Strategy

### Risk-based ordering

Migrate flows in order of increasing risk:

**Tier 1 — Zero-risk (read-only, internal)**
- Health checks, monitoring scripts, status collectors
- Data sync jobs that only read from external systems
- Report generators that write to internal databases only

**Tier 2 — Low-risk (non-customer-facing writes)**
- Internal notification senders (Slack/email to your own team)
- Log aggregators, metric collectors
- Database cleanup or maintenance jobs

**Tier 3 — Medium-risk (customer-adjacent writes)**
- CRM updates, lead processing
- Content scheduling (social media queues, blog posts)
- Invoice generation (before sending)

**Tier 4 — High-risk (customer-facing or financial writes)**
- Email campaigns and broadcasts
- Accounting entries (QBO, Xero, Wave writes)
- Payment processing, billing, Stripe operations
- Customer-facing approval flows

**Tier 5 — Critical (irreversible actions)**
- Bank transactions, wire transfers
- Contract execution, DocuSeal signing triggers
- Public announcements, press releases

Tier 4-5 flows should always run in shadow mode before going live. Tier 1-2 flows can go live immediately with monitoring.

### Time estimates

| Flow complexity | Rewrite time | Shadow + soak | Total |
|---|---|---|---|
| Simple cron job (no AI needed) | 30 min | 1 day | 1-2 days |
| Standard email/API flow | 1-2 hours | 2-3 days | 3-5 days |
| Multi-step with approvals | 2-4 hours | 3-5 days | 5-7 days |
| Complex pipeline with fan-out | 4-8 hours | 5-7 days | 1-2 weeks |
| Critical financial flow | 4-8 hours | 1-2 weeks shadow | 2-3 weeks |

---

## 8. Reverting a Flow

### Quick revert (< 1 minute)

```bash
# 1. Stop the Nexaas version
ssh <vps> 'nexaas skill disable <skill-id>'

# 2. Re-enable the source version
# For Trigger.dev:
ssh <vps> 'cd /path/to/trigger-project && npx trigger.dev@latest schedules enable <schedule-id>'

# For n8n:
ssh <vps> 'curl -X PATCH http://localhost:5678/api/v1/workflows/<id> -H "Content-Type: application/json" -d '\''{"active": true}'\'''

# For cron:
ssh <vps> 'crontab -e'  # uncomment the line

# For systemd timer:
ssh <vps> 'sudo systemctl start <timer-name>.timer'
```

### Nuclear revert (all flows, < 2 minutes)

If the entire Nexaas runtime is unstable:

```bash
# 1. Stop all Nexaas services
ssh <vps> 'sudo systemctl stop nexaas-worker'

# 2. Re-enable ALL source system flows
# For Trigger.dev: restart the worker
ssh <vps> 'sudo systemctl start trigger-dev-worker'  # or equivalent

# For n8n: reactivate all workflows
ssh <vps> 'n8n-cli workflow:activate --all'

# For cron: restore the backed-up crontab
ssh <vps> 'crontab /backup/crontab.bak'
```

You are now back to exactly where you were before migration began. The source system's code was never changed; its state was never altered; its scheduling was only disabled (not deleted).

### What happens to Nexaas data after revert

Palace drawers written during the Nexaas run stay in Postgres but are inert — no Nexaas worker is processing them. They're useful as an audit trail of what happened during the migration attempt. If you want a clean slate for a retry, drop and recreate the palace schema:

```bash
ssh <vps> 'psql -d nexaas -c "DROP SCHEMA nexaas_memory CASCADE"'
ssh <vps> 'psql -d nexaas < /opt/nexaas/database/migrations/012_palace_substrate.sql'
```

---

## 9. Post-Migration Cleanup

### When to remove the source system

Only after ALL of the following are true:

- [ ] Every flow has been running on Nexaas for at least one full week
- [ ] No reverts have been needed in the last 7 days
- [ ] WAL verification passes on every bi-daily check
- [ ] Ops has reviewed the migration report and signed off
- [ ] A backup of the source system's configuration and state has been taken

### Removing Trigger.dev

```bash
# Stop the worker
sudo systemctl stop trigger-dev-worker
sudo systemctl disable trigger-dev-worker

# Stop the Docker stack
cd /path/to/trigger-dev && docker compose down

# Optionally remove the containers and images
docker compose down --rmi all --volumes

# The trigger-dev directory stays on disk as an archive
# Move it to a backup location if desired
mv /path/to/trigger-dev /backup/trigger-dev-archive-$(date +%Y%m%d)
```

Expected resource recovery: 4-6 GB RAM (Docker stack), significant CPU relief (no ClickHouse, no Electric, no MinIO).

### Removing n8n

```bash
# If running as a Docker container
docker stop n8n && docker rm n8n

# If running as a system service
sudo systemctl stop n8n
sudo systemctl disable n8n

# Archive the n8n data directory
mv ~/.n8n /backup/n8n-archive-$(date +%Y%m%d)
```

### Removing custom cron jobs

```bash
# Back up the current crontab
crontab -l > /backup/crontab-$(date +%Y%m%d).bak

# Remove the migrated entries (keep any non-migrated ones)
crontab -e
# Comment out or delete the migrated lines
```

---

## 10. Troubleshooting

### Flow runs but produces wrong output

1. Check the palace drawers for the run: `psql -d nexaas -c "SELECT content FROM nexaas_memory.events WHERE run_id = '<run-id>' ORDER BY created_at"`
2. Review the CAG context — did the skill get the right drawers from the right rooms?
3. Review the prompt — does it clearly describe the expected behavior?
4. Check the model tier — is the task too complex for the assigned tier?
5. If the output is close but not right, refine the prompt and re-run

### Flow doesn't fire on schedule

1. Check BullMQ: is the job scheduled? `nexaas skill status <skill-id>`
2. Check Redis: `redis-cli KEYS 'bull:*'`
3. Check the worker: `sudo systemctl status nexaas-worker`
4. Check the skill manifest: is the cron expression correct?
5. Check timezone: is the schedule in the expected timezone?

### Waitpoint never resolves

1. Check if the notification was sent: look for drawers in `notifications.pending.*`
2. Check the channel adapter: did the message reach the human?
3. Check the resolve endpoint: is `/api/v1/waitpoints/:signal/resolve` accessible?
4. Check if the waitpoint timed out: look for timeout drawers in `ops.escalations.*`
5. Manual resolve: `nexaas waitpoint resolve <signal> --decision approve --actor ops`

### WAL verification fails

This is a critical alert. Possible causes:

1. **Database was restored from a backup** that predates some WAL entries — expected, re-run `verify-wal` with `--from-id` set to the first entry after the restore point
2. **A bug in the WAL append** — check the logs for UNIQUE constraint violations or hash mismatches
3. **Tampering** — investigate immediately; check database access logs, review recent operator actions

### BullMQ worker crashes repeatedly

1. Check system resources: `free -h`, `df -h`, `uptime`
2. Check worker logs: `journalctl -u nexaas-worker -n 100`
3. Check Redis: `redis-cli INFO memory`
4. If out of memory: check for runaway jobs, increase `MemoryMax` in the systemd unit, or investigate which skill is consuming excessive memory
5. If a specific skill crashes the worker: disable that skill, revert it to the source system, and investigate

### Performance degraded after migration

1. Compare resource usage before and after: Nexaas should use less than Trigger.dev (no Docker stack overhead), not more
2. Check for excessive palace writes: a skill writing thousands of drawers per run may be misconfigured
3. Check closet compaction: is it keeping up? Look at staleness readings
4. Check pgvector index: for large collections, the HNSW index may need tuning

---

## 11. Source-System-Specific Notes

### Trigger.dev specifics

- The `.trigger/` directory contains dev-mode cache and lock files. These are not needed after migration and can be archived.
- Trigger.dev's internal Postgres database (inside the Docker stack) is separate from Nexaas's Postgres. It's not affected by any Nexaas operations.
- If the Trigger.dev worker was leaking orphan processes (the `setsid` bug), the orphan-janitor systemd timer should stay active until Trigger.dev is fully removed.
- Trigger.dev schedules can be listed with `npx trigger.dev@latest schedules list` — useful for verifying which schedules are disabled vs. still active.

### n8n specifics

- n8n workflows can be exported as JSON for reference during rewriting. Use the n8n API: `GET /api/v1/workflows/<id>`.
- n8n credentials are encrypted in `~/.n8n/database.sqlite`. They cannot be directly extracted — re-enter them in Nexaas's integration_connections table via the client dashboard OAuth flows.
- n8n's execution history is useful for understanding flow behavior during rewriting. Export it before removing n8n.
- If n8n was running with a community node that accessed an unusual API, check whether a Nexaas MCP exists for that API. If not, create one using the `@nexaas/mcp-server` framework.

### Custom script specifics

- Back up every script before starting. Even if the script is in version control, confirm the running version matches the repo version (cron jobs often diverge from checked-in code).
- Check for environment variables the script depends on. These need to be set in Nexaas's `.env` or `.env.platform`.
- Check for file locks, PID files, or temp directories the script creates. Nexaas doesn't need these (BullMQ handles concurrency), but leftover lock files from the old script could confuse cleanup.
- If the script sources a `.bashrc` or `.profile` for environment setup, those variables need to be explicitly set in the Nexaas configuration.

---

## 12. Migration Completion Checklist

### Per-flow

- [ ] Skill manifest written and validated (`nexaas validate-skill <id>`)
- [ ] Prompt written and reviewed
- [ ] Source system flow disabled (not deleted)
- [ ] Nexaas skill enabled and first execution verified
- [ ] Shadow mode completed (if applicable) with output comparison
- [ ] Full business cycle (1 week minimum) completed on Nexaas
- [ ] WAL entries verified for this skill's runs
- [ ] No reverts needed during the soak period
- [ ] Source system flow marked as "migrated — safe to remove after fleet cleanup"

### Fleet-wide (after all flows migrated)

- [ ] All flows running on Nexaas for 1+ week with no issues
- [ ] WAL verification passing on all bi-daily checks
- [ ] No source system flows still active
- [ ] Resource usage is at or below pre-migration levels
- [ ] Ops team has reviewed the full migration report
- [ ] Source system backed up and archived
- [ ] Source system services stopped and disabled
- [ ] Source system Docker containers removed (if applicable)
- [ ] Migration documented in ops runbook for future reference
