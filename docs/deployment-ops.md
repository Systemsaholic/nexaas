# Nexaas Deployment & Operations Guide

**Lessons learned from Phoenix Voyages production deployment (2026-04-16 → 2026-04-18)**

> **Which deployment mode?** This guide covers operational recipes that apply in both modes. For the conceptual difference between **direct adopter** (single tenant, manifest in workspace repo) and **operator-managed** (N tenants, manifests propagated from an operator VPS), see [`deployment-patterns.md`](./deployment-patterns.md) first.

---

## 1. Fresh Deployment

```bash
nexaas init --workspace <id>
```

This handles: prerequisites, DB creation, migrations, .env generation, operator bootstrap, systemd service.

### Post-init checklist

- [ ] Set timezone: `nexaas config timezone America/Toronto`
- [ ] Set workspace root: `nexaas config workspace_root /home/ubuntu/MyWorkspace`
- [ ] Seed palace: `nexaas seed-palace /home/ubuntu/MyWorkspace`
- [ ] Create backup dir: `sudo mkdir -p /var/backups/nexaas && sudo chown $USER /var/backups/nexaas`
- [ ] First backup: `nexaas backup run && nexaas backup test 1`
- [ ] Verify: `nexaas status`

---

## 2. Legacy System Removal (CRITICAL)

If deploying to a VPS that previously used Trigger.dev, N8N, or other automation systems, **all legacy artifacts must be archived**. Leaving them in place causes Claude Code to revert to old patterns.

### Archive procedure

```bash
# Create archive directory
mkdir -p ~/.archive-legacy-$(date +%Y-%m-%d)

# Archive Trigger.dev code
mv ~/MyWorkspace/trigger-dev ~/.archive-legacy-$(date +%Y-%m-%d)/
mv ~/MyWorkspace/infrastructure/trigger-dev ~/.archive-legacy-$(date +%Y-%m-%d)/

# Archive old framework directories
mv ~/MyWorkspace/framework ~/.archive-legacy-$(date +%Y-%m-%d)/
mv ~/MyWorkspace/nexaas-framework ~/.archive-legacy-$(date +%Y-%m-%d)/

# Archive legacy Python scripts
mv ~/MyWorkspace/*.py ~/.archive-legacy-$(date +%Y-%m-%d)/ 2>/dev/null

# Archive migration docs referencing old systems
mv ~/MyWorkspace/MIGRATION.md ~/.archive-legacy-$(date +%Y-%m-%d)/ 2>/dev/null
```

### Disable legacy services

```bash
for svc in trigger-dev-worker trigger-dev-platform trigger-dev-orphan-janitor nexaas-engine; do
  sudo systemctl stop $svc 2>/dev/null
  sudo systemctl disable $svc 2>/dev/null
  sudo mv /etc/systemd/system/$svc.service ~/.archive-legacy-$(date +%Y-%m-%d)/ 2>/dev/null
done
sudo systemctl daemon-reload
```

### Remove Docker artifacts

```bash
# Remove Trigger.dev images
docker rmi $(docker images --format '{{.Repository}}:{{.Tag}}' | grep trigger) 2>/dev/null

# Remove Trigger.dev volumes (WARNING: irreversible)
docker volume ls -q | grep trigger | xargs -r docker volume rm

# Reclaim space
docker system prune -f
```

### Update workspace CLAUDE.md

Replace ALL legacy automation sections with Nexaas-only instructions. The CLAUDE.md must contain:

1. **Automation Framework section** with clear "CRITICAL: Nexaas is the ONLY automation framework" header
2. **Memory guidance blockquote** (palace vs Claude Code memory)
3. **Zero references** to Trigger.dev, `claude --print`, or old framework as active systems

See Phoenix Voyages CLAUDE.md for the canonical template.

---

## 3. Systemd Service Configuration

### What works (learned the hard way)

```ini
[Service]
# Direct node invocation — NOT npm/npx (snap node through npm swallows stdout)
ExecStart=/snap/bin/node /opt/nexaas/node_modules/.bin/tsx /opt/nexaas/packages/runtime/src/worker.ts

# Orphan process cleanup — prevents port 9090 from being held by zombie processes
ExecStopPost=/bin/sh -c 'fuser -k -TERM 9090/tcp 2>/dev/null; sleep 2; fuser -k -KILL 9090/tcp 2>/dev/null; exit 0'

# Kill mode — mixed ensures all descendants are killed, not just the main PID
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=15

# Logging — explicit even though it's the default, because snap node can break inheritance
StandardOutput=journal
StandardError=journal
```

### What breaks

- `ExecStart=/snap/bin/npx tsx ...` — npm creates a shell wrapper chain that escapes cgroup cleanup and swallows stdout
- `KillMode=control-group` (default) — orphan tsx child processes survive stop
- No `ExecStopPost` — port stays held after stop, next start fails with EADDRINUSE
- No port check before BullMQ init — worker connects to Redis, accepts jobs, THEN crashes on listen(), leaving orphaned `skill_runs`

### Snap node caveat

Node installed via snap (`/snap/bin/node`) does not reliably pipe stdout to systemd's journal, even with `StandardOutput=journal`. The `nexaas status` and `nexaas health` commands work as alternatives. If proper journald logging is required, install node via nvm or apt instead.

---

## 4. Worker Startup Sequence

The worker performs these steps on boot (order matters):

1. **Port check** — fail fast if 9090 is occupied (prevents job-accepting-then-crashing)
2. **Postgres pool** — initialize connection
3. **Reconcile orphaned skill_runs** — any `status='running'` with `last_activity > 2 min` → cancelled
4. **Deduplicate BullMQ repeatables** — remove stale/duplicate repeat entries
5. **Start BullMQ worker** — begin accepting jobs
6. **Start outbox relay** — poll Postgres outbox for deferred jobs
7. **Start Express** — Bull Board + health endpoint on port 9090
8. **Background tasks** — compaction (5min), reaper (60s), health monitor (5min)
9. **Initial health check** (15s delay) — non-fatal, prevents startup deadlock

### Known pitfalls

- **Health monitor deadlock**: The health monitor used `execSync("curl localhost:9090/health")` which blocks the same event loop serving that endpoint. Fixed by using `process.uptime()` directly.
- **NULL workspace in job data**: BullMQ scheduler-spawned jobs may arrive with empty `data` when the scheduler template isn't persisted. Worker falls back to `process.env.NEXAAS_WORKSPACE`.
- **Duplicate skill_runs**: Shell/AI skill executors create their own run records. The worker must NOT also create one, or orphaned `running` rows accumulate.

---

## 5. Skill Registration

```bash
nexaas register-skill /path/to/skill.yaml
```

Uses `upsertJobScheduler` (idempotent). Also cleans up any legacy `repeat:` entries for the same skill name.

### Re-registering all skills cleanly

If duplicate repeatables accumulate:

```bash
# Nuclear option: clear all repeatables and re-register
redis-cli --scan --pattern "bull:nexaas-skills-*:repeat:*" | xargs -r redis-cli DEL

# Re-register everything
for yaml in ~/MyWorkspace/nexaas-skills/*/skill.yaml ~/MyWorkspace/nexaas-skills/*/*/skill.yaml; do
  [ -f "$yaml" ] && nexaas register-skill "$yaml"
done
```

---

## 6. Converting Legacy Automations

Use `/nexaasify` from a Claude Code session on the workspace VPS. It handles:
- YAML check → Nexaas skill (maps agent configs to MCP servers)
- Shell script → shell skill
- `claude --print` invocation → ai-skill (MUST convert, never keep)
- Cron job → skill with cron trigger

### Common anti-patterns to catch during conversion

| Anti-pattern | Fix |
|---|---|
| `claude --print -m sonnet --mcp server` | `execution.type: ai-skill` + `model_tier: good` + `mcp_servers: [server]` |
| `claude --print` with `-m` flag (doesn't exist) | Use `model_tier` in manifest |
| `claude --print` with `--mcp` flag (doesn't exist) | Use `mcp_servers` in manifest |
| Shell skill that calls Claude CLI | Convert to `ai-skill` type |
| Hardcoded model names (`claude-sonnet-4-6`) | Use tiers: `cheap\|good\|better\|best` |
| No prompt.md for AI skill | Write one with Self-Reflection Protocol |
| Missing timezone in manifest | Add `timezone: America/Toronto` |

---

## 7. Memory Architecture

### What goes where

| Data type | Storage | Why |
|---|---|---|
| Business state (leads, invoices, decisions) | Palace drawers | Skills, sessions, and team members need it |
| Operational decisions ("retired X", "changed Y") | Palace WAL | Auditable, searchable, survives sessions |
| Skill results and findings | Palace drawers | Other skills read them for context (CAG) |
| Agent/skill prompts, runbooks, templates | Palace (seeded from files) | CAG walks these rooms for context |
| Static reference data (advisors, suppliers) | YAML files + palace seed | Humans edit YAML, palace has a copy for skills |
| Live operational state (followups, commitments) | Palace drawers (migrate from YAML) | Flat files can't be read by skills |
| User preferences ("prefers terse responses") | Claude Code local memory | Personal, doesn't affect business |
| MCP configs, agent configs, skill manifests | YAML files | Configuration, not state |

### YAML registries are fine for

- Reference data that humans edit and skills read (advisors, suppliers, business-info)
- Agent configuration (config.yaml, prompt.md)
- Skill manifests (skill.yaml)
- Marketing templates

### YAML is wrong for

- Operational state (followups, commitments, recent-actions) — should be palace drawers
- Check dispatch state (last_run timestamps) — palace tracks this
- Session tracking — palace handles via skill_runs
- Anything skills write to — must be palace, not file writes

---

## 8. Monitoring

### Health commands

```bash
nexaas status          # Quick: worker, Redis, Postgres, API key, WAL, active runs
nexaas health          # Detailed: 10-point check with alerts
nexaas alerts          # Recent notification history
nexaas alerts config   # Notification channel status
nexaas alerts test     # Send test notification to all channels
```

### Notification channels

Configure in `.env`:

```bash
# Telegram (critical + warning)
TELEGRAM_BOT_TOKEN=bot123:ABC...
TELEGRAM_ALERT_CHAT_ID=-100123456

# Email via Resend (critical only)
RESEND_API_KEY=re_abc123...
OPS_ALERT_EMAIL=ops@example.com
OPS_ALERT_FROM="Nexaas Alerts <alerts@nexmatic.ca>"
```

Routing: critical → Telegram + Email + Palace, warning → Telegram + Palace, info → Palace only.

### Automated backups

```bash
# Daily at 3 AM
crontab -e
0 3 * * * source /opt/nexaas/.env && /usr/local/bin/nexaas backup run >> /var/log/nexaas-backup.log 2>&1
```

Backups are gzipped pg_dump of `nexaas_memory` schema with SHA256 verification and 30-backup retention.

---

## 9. Upgrading

```bash
nexaas upgrade --check    # Preview: commits behind, pending migrations
nexaas upgrade            # Pull + install + migrate + restart + verify
```

The upgrade command:
1. Fetches latest from git
2. Runs `npm install` if package.json changed
3. Applies pending database migrations (tracked in `schema_migrations`)
4. Restarts the worker
5. Waits for health check (up to 30s)
6. Records version in `framework_versions` table
