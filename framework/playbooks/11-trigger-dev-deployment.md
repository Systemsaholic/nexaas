# Playbook 11: Trigger.dev v4 Self-Hosted Deployment

Lessons learned from deploying the Nexaas orchestrator on a 4GB OVH VPS. This playbook ensures client instances deploy cleanly without the pain we experienced.

## What We Learned (The Hard Way)

### Critical: Image Tags

| Tag | Version | Status |
|---|---|---|
| `ghcr.io/triggerdotdev/trigger.dev:latest` | v2/v3 (Feb 2024) | **DO NOT USE** |
| `ghcr.io/triggerdotdev/trigger.dev:v4-beta` | v4 beta | Works (Phoenix uses this) |
| `ghcr.io/triggerdotdev/trigger.dev:v4.4.3` | v4.4.3 | Works (orchestrator uses this) |

**Always pin the version.** The `latest` tag is years behind and completely incompatible with the v4 CLI.

### Required Services (6 containers)

Trigger.dev v4 requires ALL of these — not optional:

| Service | Image | Why |
|---|---|---|
| Webapp | `trigger.dev:v4.4.3` | The application |
| Postgres 14 | `postgres:14` | Primary database (must have `wal_level=logical`) |
| Redis 7 | `redis:7` | Queue backend |
| ElectricSQL | `electricsql/electric:1.2.4` | Real-time sync (v4 requirement) |
| ClickHouse | `bitnamilegacy/clickhouse:latest` | Run analytics |
| MinIO | `bitnamilegacy/minio:latest` | Object storage for payloads |

### Memory Requirements

| VPS RAM | NODE_MAX_OLD_SPACE_SIZE | mem_limit | Status |
|---|---|---|---|
| 4 GB | 800 | **NONE** (remove all) | Works, tight |
| 8 GB | 1600 | Optional 512m per container | Comfortable |
| 22 GB | 1600 | As desired | Phoenix setup |

**DO NOT set `mem_limit` on containers with < 8GB RAM.** Containers OOM silently and crash-loop. Docker's memory accounting causes the webapp to be killed before it finishes initialization.

### ClickHouse Gotchas

1. **Use `bitnamilegacy/clickhouse:latest`** — not the official `clickhouse/clickhouse-server`. The official image has incompatible JSON type settings.

2. **Custom entrypoint required** — The default entrypoint forces `?secure=true` on ClickHouse URLs (for TLS), which breaks connections to non-TLS ClickHouse. Our custom entrypoint uses `?secure=false`.

3. **Goose migrations are non-fatal** — Migration 003 uses `CREATE TABLE` (not `IF NOT EXISTS`). If the container restarts mid-migration, goose fails on retry. The custom entrypoint catches this with `|| echo "non-fatal"`.

4. **Low-memory config needed** — Without `override.xml`, ClickHouse tries to use too much RAM. The override limits block sizes and thread counts.

### Docker Networking

- **DO NOT use native Postgres with Docker Trigger.dev.** Docker-to-host networking (`host.docker.internal`, `172.17.0.1`) is unreliable on Linux. Postgres connections drop intermittently, causing crash loops.
- **Use containerized Postgres** inside the same docker-compose network. All services reference each other by service name.

### Encryption Keys

All secrets must be exactly **16 bytes hex** (32 characters):
```bash
openssl rand -hex 16
```

Using longer keys (e.g., 32 bytes from `openssl rand -hex 32`) causes "Invalid key length" errors in the auth flow.

### CLI Authentication

The `trigger.dev login` command requires an **interactive browser flow**:

1. CLI generates an authorization code URL on the self-hosted instance
2. User must visit that URL **in a browser where they're already logged in**
3. CLI polls for ~2 minutes waiting for the auth to complete
4. On success, saves a PAT to `~/.config/trigger/config.json`

**Cannot be automated with Playwright** — the browser sessions don't share cookies with the CLI's polling mechanism. The auth code is session-bound.

**For automation:** The PAT is stored encrypted in the DB. We need to either:
- Use Playwright on the VPS itself (install headless Chrome)
- Build a script that creates PATs via Trigger.dev's internal encryption
- Do the login once manually, then copy the config to new instances

### APP_ORIGIN / LOGIN_ORIGIN

Must match the URL users actually access the dashboard from:
- Tailscale: `https://nexaas-{name}.tail0326d4.ts.net`
- Direct: `http://localhost:3040`

If these don't match, cookies won't work and the magic link auth flow breaks.

---

## Working Deployment Template

### Files Needed

```
platform/
├── docker-compose.orchestrator.yml   # Main compose file
├── entrypoint.sh                      # Custom entrypoint (handles goose failures)
├── clickhouse/
│   └── override.xml                   # Low-memory ClickHouse config
└── .env                               # Generated secrets
```

### Step-by-Step (Automated)

```bash
#!/bin/bash
# deploy-trigger.sh — Deploy Trigger.dev v4 on a VPS
# Usage: ./deploy-trigger.sh <vps-ssh> <app-origin> <admin-email>
set -e

VPS=$1
APP_ORIGIN=$2
ADMIN_EMAIL=$3
NEXAAS_ROOT=/opt/nexaas

# 1. Generate secrets
PG_PASS=$(openssl rand -hex 12)
CH_PASS=$(openssl rand -hex 12)
MINIO_PASS=$(openssl rand -hex 12)
SESSION=$(openssl rand -hex 16)
MAGIC=$(openssl rand -hex 16)
ENCRYPT=$(openssl rand -hex 16)
MANAGED=$(openssl rand -hex 16)
OBJ_SECRET=$(openssl rand -hex 16)

# 2. Create .env
cat > /tmp/trigger.env << EOF
SESSION_SECRET=${SESSION}
MAGIC_LINK_SECRET=${MAGIC}
ENCRYPTION_KEY=${ENCRYPT}
MANAGED_WORKER_SECRET=${MANAGED}
APP_ORIGIN=${APP_ORIGIN}
LOGIN_ORIGIN=${APP_ORIGIN}
NODE_MAX_OLD_SPACE_SIZE=800
POSTGRES_PASSWORD=${PG_PASS}
DATABASE_URL=postgresql://postgres:${PG_PASS}@trigger-postgres:5432/trigger
DIRECT_URL=postgresql://postgres:${PG_PASS}@trigger-postgres:5432/trigger
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=${CH_PASS}
CLICKHOUSE_URL=http://default:${CH_PASS}@trigger-clickhouse:8123
RUN_REPLICATION_CLICKHOUSE_URL=http://default:${CH_PASS}@trigger-clickhouse:8123
MINIO_ROOT_USER=triggeradmin
MINIO_ROOT_PASSWORD=${MINIO_PASS}
OBJECT_STORE_ACCESS_KEY_ID=triggeradmin
OBJECT_STORE_SECRET_ACCESS_KEY=${OBJ_SECRET}
TRIGGER_TELEMETRY_DISABLED=1
WHITELISTED_EMAILS=${ADMIN_EMAIL}
RESTART_POLICY=unless-stopped
EOF

# 3. Copy files to VPS
scp /tmp/trigger.env ${VPS}:${NEXAAS_ROOT}/platform/.env
scp ${NEXAAS_ROOT}/platform/docker-compose.orchestrator.yml ${VPS}:${NEXAAS_ROOT}/platform/
scp ${NEXAAS_ROOT}/platform/entrypoint.sh ${VPS}:${NEXAAS_ROOT}/platform/
scp -r ${NEXAAS_ROOT}/platform/clickhouse ${VPS}:${NEXAAS_ROOT}/platform/
ssh ${VPS} "chmod +x ${NEXAAS_ROOT}/platform/entrypoint.sh"

# 4. Start stack
ssh ${VPS} "cd ${NEXAAS_ROOT}/platform && docker compose -f docker-compose.orchestrator.yml -p trigger up -d"

# 5. Wait for health (webapp takes 60-90 seconds)
echo "Waiting for Trigger.dev to start (90 seconds)..."
sleep 90

# 6. Verify
HTTP_CODE=$(ssh ${VPS} "curl -s -o /dev/null -w '%{http_code}' http://localhost:3040/")
if [ "$HTTP_CODE" = "302" ]; then
  echo "Trigger.dev is running!"
else
  echo "WARNING: HTTP ${HTTP_CODE} — check docker logs"
  ssh ${VPS} "docker logs trigger-trigger-webapp-1 2>&1 | tail -20"
fi

# 7. Get project ref and dev key (after manual login + project creation)
echo ""
echo "MANUAL STEP REQUIRED:"
echo "  1. SSH into ${VPS}"
echo "  2. Run: npx trigger.dev@latest login -a http://localhost:3040"
echo "  3. Open the auth URL in your browser"
echo "  4. Create org + project in the dashboard"
echo "  5. Then run the worker with the project ref + dev key"
```

### Step That Needs Manual Intervention

The CLI login requires visiting a URL in a browser while logged into the Trigger.dev dashboard. This is the ONE manual step per deployment:

```bash
# On the VPS:
npx trigger.dev@latest login -a http://localhost:3040
# Copy the URL it prints, open in browser, click through
```

### Starting the Worker

After login, start the worker:

```bash
TRIGGER_SECRET_KEY=<dev-server-key> \
TRIGGER_API_URL=http://localhost:3040 \
npx trigger.dev@latest dev \
  --skip-update-check \
  --project-ref <project-ref> \
  --config trigger/trigger.config.ts
```

Get the project ref and dev key from:
```bash
# Project ref
docker exec trigger-trigger-postgres-1 psql -U postgres -d trigger -t -A \
  -c 'SELECT "externalRef" FROM "Project" LIMIT 1'

# Dev server key
docker exec trigger-trigger-postgres-1 psql -U postgres -d trigger -t -A \
  -c "SELECT \"apiKey\" FROM \"RuntimeEnvironment\" WHERE type = 'DEVELOPMENT' LIMIT 1"
```

---

## What Needs Automation (Future)

| Step | Current | Target |
|---|---|---|
| Generate secrets + .env | Manual | `deploy-trigger.sh` script |
| Copy files + start stack | Manual | `deploy-trigger.sh` script |
| Wait for health | Manual | Script with retry loop |
| CLI login | **Manual (browser required)** | Playwright on VPS or API-based PAT creation |
| Create org + project | **Manual (dashboard)** | Playwright automation or Trigger.dev API |
| Get project ref + dev key | Manual psql query | Script extracts from DB |
| Start worker | Manual | systemd service (already have template) |

**Biggest automation gap:** The CLI login requires a browser. Options:
1. Install headless Chrome + Playwright on VPS, automate the full flow
2. Build a script that creates properly encrypted PATs directly in the DB
3. Pre-create a shared PAT on the orchestrator, copy to client configs

---

## Quick Reference

### VPS Requirements

| Spec | Minimum | Recommended |
|---|---|---|
| RAM | 4 GB | 8 GB |
| CPU | 2 vCPU | 4 vCPU |
| Disk | 20 GB free | 50 GB free |
| OS | Ubuntu 24.04 | Ubuntu 24.04 |
| Docker | 24+ | Latest |
| Node.js | 20+ | 20 LTS |

### Port Map

| Port | Service | Bind |
|---|---|---|
| 3040 | Trigger.dev webapp | 0.0.0.0 (Tailscale) or 127.0.0.1 |
| 5432 | Postgres (internal) | Container only |
| 6379 | Redis (internal) | Container only |
| 8123 | ClickHouse HTTP (internal) | Container only |
| 9000 | MinIO (internal) | Container only |

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `latest` tag won't start | Wrong version (v2/v3) | Use `v4.4.3` or `v4-beta` |
| Webapp crash-loops, no error | OOM from `mem_limit` | Remove all `mem_limit` directives |
| `CLICKHOUSE_URL` goose error | Wrong ClickHouse image or secure=true | Use bitnamilegacy + custom entrypoint |
| `Invalid key length` | Encryption key too long | Use `openssl rand -hex 16` (16 bytes) |
| CLI login times out | Auth URL not visited in time | Run login interactively on VPS |
| `host.docker.internal` fails | Linux Docker networking | Use containerized Postgres |
| `SESSION_SECRET required` | Missing env var in compose | Add to environment section |
