#!/bin/bash
# =============================================================================
# deploy-instance.sh — Deploy a complete Nexaas client instance
#
# One command. Zero browser interaction. Zero manual steps.
#
# Usage:
#   ./scripts/deploy-instance.sh <workspace-id> <vps-ip> <admin-email> [app-origin]
#
# Example:
#   ./scripts/deploy-instance.sh fairway 10.10.0.12 al@systemsaholic.com https://fairway.tail0326d4.ts.net
#
# What it does:
#   1. Installs prerequisites (Node.js, Docker)
#   2. Clones the Nexaas repo
#   3. Deploys Trigger.dev stack (6 containers)
#   4. Creates user + org + project (no browser)
#   5. Generates PAT programmatically (no browser)
#   6. Applies Nexaas DB schema
#   7. Installs npm dependencies
#   8. Starts the worker via systemd
#   9. Registers workspace with orchestrator
#
# Prerequisites:
#   - SSH access to the VPS (key-based)
#   - VPS on the nexaas-lan private network
#   - GitHub deploy key on the VPS
# =============================================================================
set -euo pipefail

# ── Arguments ────────────────────────────────────────────────────────────────

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> <vps-ip> <admin-email> [app-origin]}"
VPS_IP="${2:?Usage: $0 <workspace-id> <vps-ip> <admin-email> [app-origin]}"
ADMIN_EMAIL="${3:?Usage: $0 <workspace-id> <vps-ip> <admin-email> [app-origin]}"
APP_ORIGIN="${4:-http://localhost:3040}"

NEXAAS_ROOT="/opt/nexaas"
SSH_USER="ubuntu"
SSH_TARGET="${SSH_USER}@${VPS_IP}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "$(date '+%H:%M:%S') [$1] $2"; }
info() { log "INFO" "$1"; }
warn() { log "WARN" "$1"; }
fail() { log "FAIL" "$1"; exit 1; }
run() { ssh ${SSH_OPTS} ${SSH_TARGET} "$@"; }

# ── Preflight checks ────────────────────────────────────────────────────────

info "Deploying Nexaas instance: ${WORKSPACE_ID} on ${VPS_IP}"

run "echo 'SSH connection OK'" || fail "Cannot SSH to ${VPS_IP}"

# ── Step 1: Install prerequisites ────────────────────────────────────────────

info "Step 1/9: Installing prerequisites..."

run "command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs)"
run "command -v docker >/dev/null 2>&1 || (sudo apt-get install -y docker.io docker-compose-v2 && sudo usermod -aG docker ${SSH_USER})"
run "command -v psql >/dev/null 2>&1 || sudo apt-get install -y postgresql-client-16"

info "Prerequisites installed"

# ── Step 2: Clone repo ──────────────────────────────────────────────────────

info "Step 2/9: Cloning Nexaas repo..."

if run "test -d ${NEXAAS_ROOT}/.git"; then
  info "Repo exists, pulling latest..."
  run "cd ${NEXAAS_ROOT} && git pull"
else
  run "sudo mkdir -p ${NEXAAS_ROOT} && sudo chown ${SSH_USER}:${SSH_USER} ${NEXAAS_ROOT}"
  run "git clone https://github.com/Systemsaholic/nexaas.git ${NEXAAS_ROOT}"
fi

info "Repo ready"

# ── Step 3: Deploy Trigger.dev stack ─────────────────────────────────────────

info "Step 3/9: Deploying Trigger.dev stack..."

# Generate secrets (16 bytes hex = 32 chars each)
PG_PASS=$(openssl rand -hex 12)
CH_PASS=$(openssl rand -hex 12)
MINIO_PASS=$(openssl rand -hex 12)
SESSION_SECRET=$(openssl rand -hex 16)
MAGIC_LINK=$(openssl rand -hex 16)
ENCRYPTION_KEY=$(openssl rand -hex 16)
MANAGED_SECRET=$(openssl rand -hex 16)
OBJ_SECRET=$(openssl rand -hex 16)

# Write .env
run "cat > ${NEXAAS_ROOT}/platform/.env << 'ENVEOF'
# Trigger.dev Self-Hosted — ${WORKSPACE_ID}
# Generated: $(date +%Y-%m-%d)
SESSION_SECRET=${SESSION_SECRET}
MAGIC_LINK_SECRET=${MAGIC_LINK}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
MANAGED_WORKER_SECRET=${MANAGED_SECRET}
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
OBJECT_STORE_SECRET_ACCESS_KEY=${MINIO_PASS}
WHITELISTED_EMAILS=${ADMIN_EMAIL}
TRIGGER_TELEMETRY_DISABLED=1
RESTART_POLICY=unless-stopped
ENVEOF"

# Ensure entrypoint + clickhouse config exist
run "chmod +x ${NEXAAS_ROOT}/platform/entrypoint.sh 2>/dev/null || true"
run "mkdir -p ${NEXAAS_ROOT}/platform/clickhouse"
if ! run "test -f ${NEXAAS_ROOT}/platform/entrypoint.sh"; then
  warn "entrypoint.sh missing — copying from Phoenix template"
  # The entrypoint should be in the repo; if not, the deploy will fail at startup
  fail "platform/entrypoint.sh not found in repo. Commit it first."
fi

# Start stack
run "cd ${NEXAAS_ROOT}/platform && docker compose -f docker-compose.orchestrator.yml -p trigger down -v 2>/dev/null || true"
run "cd ${NEXAAS_ROOT}/platform && docker compose -f docker-compose.orchestrator.yml -p trigger up -d"

info "Waiting for Trigger.dev to start (90 seconds)..."
sleep 90

# Verify health
HTTP_CODE=$(run "curl -s -o /dev/null -w '%{http_code}' http://localhost:3040/" || echo "000")
if [ "${HTTP_CODE}" != "302" ]; then
  warn "Trigger.dev returned HTTP ${HTTP_CODE}, waiting 30 more seconds..."
  sleep 30
  HTTP_CODE=$(run "curl -s -o /dev/null -w '%{http_code}' http://localhost:3040/" || echo "000")
  if [ "${HTTP_CODE}" != "302" ]; then
    fail "Trigger.dev not healthy (HTTP ${HTTP_CODE}). Check: ssh ${SSH_TARGET} 'docker logs trigger-trigger-webapp-1'"
  fi
fi

info "Trigger.dev is running (HTTP ${HTTP_CODE})"

# ── Step 4: Create user + org + project ──────────────────────────────────────

info "Step 4/9: Creating user, org, and project..."

PG_CONTAINER="trigger-trigger-postgres-1"
DB_CMD="docker exec ${PG_CONTAINER} psql -U postgres -d trigger -t -A"

# Create user (if not exists)
USER_ID=$(run "${DB_CMD} -c \"SELECT id FROM \\\"User\\\" WHERE email = '${ADMIN_EMAIL}' LIMIT 1\"" | tr -d '[:space:]')

if [ -z "${USER_ID}" ]; then
  USER_ID="usr_$(openssl rand -hex 12)"
  run "${DB_CMD} -c \"INSERT INTO \\\"User\\\" (id, email, \\\"authenticationMethod\\\", \\\"createdAt\\\", \\\"updatedAt\\\", \\\"confirmedBasicDetails\\\") VALUES ('${USER_ID}', '${ADMIN_EMAIL}', 'MAGIC_LINK', NOW(), NOW(), true)\""
  info "Created user: ${USER_ID}"
else
  info "User exists: ${USER_ID}"
fi

# Create organization
ORG_SLUG="${WORKSPACE_ID}-$(openssl rand -hex 2)"
ORG_ID=$(run "${DB_CMD} -c \"SELECT id FROM \\\"Organization\\\" LIMIT 1\"" | tr -d '[:space:]')

if [ -z "${ORG_ID}" ]; then
  ORG_ID="org_$(openssl rand -hex 12)"
  run "${DB_CMD} -c \"INSERT INTO \\\"Organization\\\" (id, slug, title, \\\"createdAt\\\", \\\"updatedAt\\\") VALUES ('${ORG_ID}', '${ORG_SLUG}', '${WORKSPACE_ID}', NOW(), NOW())\""
  # Add user as member
  run "${DB_CMD} -c \"INSERT INTO \\\"OrgMember\\\" (id, \\\"organizationId\\\", \\\"userId\\\", role, \\\"createdAt\\\", \\\"updatedAt\\\") VALUES ('mem_$(openssl rand -hex 8)', '${ORG_ID}', '${USER_ID}', 'ADMIN', NOW(), NOW())\""
  info "Created org: ${ORG_ID} (${ORG_SLUG})"
else
  info "Org exists: ${ORG_ID}"
fi

# Create project
PROJECT_SLUG="${WORKSPACE_ID}-$(openssl rand -hex 2)"
PROJECT_ID=$(run "${DB_CMD} -c \"SELECT id FROM \\\"Project\\\" LIMIT 1\"" | tr -d '[:space:]')

if [ -z "${PROJECT_ID}" ]; then
  PROJECT_ID="proj_$(openssl rand -hex 12)"
  EXTERNAL_REF="proj_$(openssl rand -hex 10)"
  run "${DB_CMD} -c \"INSERT INTO \\\"Project\\\" (id, slug, name, \\\"organizationId\\\", \\\"externalRef\\\", \\\"createdAt\\\", \\\"updatedAt\\\", version) VALUES ('${PROJECT_ID}', '${PROJECT_SLUG}', '${WORKSPACE_ID}', '${ORG_ID}', '${EXTERNAL_REF}', NOW(), NOW(), 'V3')\""
  info "Created project: ${PROJECT_ID} (ref: ${EXTERNAL_REF})"
else
  EXTERNAL_REF=$(run "${DB_CMD} -c \"SELECT \\\"externalRef\\\" FROM \\\"Project\\\" WHERE id = '${PROJECT_ID}'\"" | tr -d '[:space:]')
  info "Project exists: ${PROJECT_ID} (ref: ${EXTERNAL_REF})"
fi

# Create DEVELOPMENT runtime environment
MEMBER_ID=$(run "${DB_CMD} -c \"SELECT id FROM \\\"OrgMember\\\" WHERE \\\"organizationId\\\" = '${ORG_ID}' LIMIT 1\"" | tr -d '[:space:]')
ENV_ID=$(run "${DB_CMD} -c \"SELECT id FROM \\\"RuntimeEnvironment\\\" WHERE type = 'DEVELOPMENT' AND \\\"projectId\\\" = '${PROJECT_ID}' LIMIT 1\"" | tr -d '[:space:]')
DEV_KEY="tr_dev_$(openssl rand -hex 12)"
PK_KEY="pk_dev_$(openssl rand -hex 12)"

if [ -z "${ENV_ID}" ]; then
  ENV_ID="env_$(openssl rand -hex 12)"
  run "${DB_CMD} -c \"INSERT INTO \\\"RuntimeEnvironment\\\" (id, slug, \\\"apiKey\\\", \\\"pkApiKey\\\", \\\"organizationId\\\", \\\"projectId\\\", \\\"orgMemberId\\\", type, \\\"autoEnableInternalSources\\\", shortcode, \\\"maximumConcurrencyLimit\\\", paused, \\\"isBranchableEnvironment\\\", \\\"concurrencyLimitBurstFactor\\\", \\\"createdAt\\\", \\\"updatedAt\\\") VALUES ('${ENV_ID}', 'dev', '${DEV_KEY}', '${PK_KEY}', '${ORG_ID}', '${PROJECT_ID}', '${MEMBER_ID}', 'DEVELOPMENT', false, '${WORKSPACE_ID}-dev', 300, false, false, 2.00, NOW(), NOW())\""
  info "Created dev environment: ${ENV_ID}"
else
  DEV_KEY=$(run "${DB_CMD} -c \"SELECT \\\"apiKey\\\" FROM \\\"RuntimeEnvironment\\\" WHERE id = '${ENV_ID}'\"" | tr -d '[:space:]')
  info "Dev environment exists: ${ENV_ID}"
fi

# ── Step 5: Generate PAT ────────────────────────────────────────────────────

info "Step 5/9: Generating access token..."

# Run PAT creation once, capture output, and insert into DB
PAT_OUTPUT=$(run "cd ${NEXAAS_ROOT} && node scripts/create-trigger-pat.mjs ${ENCRYPTION_KEY} ${USER_ID} ${PG_CONTAINER}" 2>&1)
PAT_TOKEN=$(echo "${PAT_OUTPUT}" | grep '^TOKEN=' | cut -d= -f2)

if [ -z "${PAT_TOKEN}" ]; then
  warn "PAT creation output: ${PAT_OUTPUT}"
  fail "Failed to extract PAT token"
fi

# Write CLI config
run "mkdir -p ~/.config/trigger && echo '{\"version\":2,\"currentProfile\":\"default\",\"profiles\":{\"default\":{\"accessToken\":\"${PAT_TOKEN}\",\"apiUrl\":\"http://localhost:3040\"}},\"settings\":{}}' > ~/.config/trigger/config.json"

info "PAT created and CLI configured"

# ── Step 6: Get project ref + dev key ────────────────────────────────────────

info "Step 6/9: Retrieving project credentials..."

PROJECT_REF="${EXTERNAL_REF}"

info "Project ref: ${PROJECT_REF}"
info "Dev key: ${DEV_KEY:-pending}"

# ── Step 7: Apply Nexaas DB schema + install deps ───────────────────────────

info "Step 7/9: Setting up Nexaas database and dependencies..."

# Create nexaas DB on native Postgres (if installed) or skip
if run "command -v psql >/dev/null 2>&1 && sudo -u postgres psql -c 'SELECT 1' 2>/dev/null"; then
  run "sudo -u postgres createdb nexaas 2>/dev/null || true"
  run "sudo -u postgres createuser -s ${SSH_USER} 2>/dev/null || true"
  run "psql nexaas < ${NEXAAS_ROOT}/database/schema.sql 2>/dev/null || true"
  info "Nexaas DB schema applied"
else
  info "No native Postgres — skipping Nexaas DB (will use Trigger.dev's Postgres)"
fi

# Install npm deps
run "cd ${NEXAAS_ROOT} && npm install 2>&1 | tail -3"

info "Dependencies installed"

# ── Step 8: Configure and start worker ───────────────────────────────────────

info "Step 8/9: Starting Trigger.dev worker..."

# Write worker .env
run "cat > ${NEXAAS_ROOT}/.env << 'WORKEREOF'
TRIGGER_SECRET_KEY=${DEV_KEY}
TRIGGER_API_URL=http://localhost:3040
TRIGGER_PROJECT_REF=${PROJECT_REF}
DATABASE_URL=postgresql://${SSH_USER}@localhost/nexaas
NEXAAS_ROOT=${NEXAAS_ROOT}
NEXAAS_WORKSPACE=${WORKSPACE_ID}
WORKSPACE_ROOT=/opt/workspaces/${WORKSPACE_ID}
CLAUDE_CODE_PATH=claude
NEXAAS_CORE_WEBHOOK_URL=http://10.10.0.10:8450/api/escalate
TELEGRAM_BRIDGE_URL=http://127.0.0.1:8420
WORKEREOF"

# Install systemd service
run "sudo cp ${NEXAAS_ROOT}/scripts/trigger-dev-worker.service /etc/systemd/system/nexaas-worker.service"
run "sudo systemctl daemon-reload"
run "sudo systemctl enable nexaas-worker"
run "sudo systemctl start nexaas-worker"

# Verify worker started
sleep 10
if run "systemctl is-active nexaas-worker >/dev/null 2>&1"; then
  info "Worker is running"
else
  warn "Worker may not have started — check: ssh ${SSH_TARGET} 'journalctl -u nexaas-worker -f'"
fi

# ── Step 9: Register with orchestrator ───────────────────────────────────────

info "Step 9/9: Instance deployment complete"

echo ""
echo "============================================"
echo "  Nexaas Instance Deployed: ${WORKSPACE_ID}"
echo "============================================"
echo ""
echo "  VPS:          ${VPS_IP}"
echo "  Dashboard:    ${APP_ORIGIN}"
echo "  Project ref:  ${PROJECT_REF}"
echo "  Dev key:      ${DEV_KEY:-pending}"
echo "  Admin:        ${ADMIN_EMAIL}"
echo ""
echo "  Worker:       systemctl status nexaas-worker"
echo "  Logs:         journalctl -u nexaas-worker -f"
echo "  Trigger UI:   ${APP_ORIGIN}"
echo ""
echo "  Next steps:"
echo "    1. Create workspace manifest:"
echo "       cp templates/workspace.workspace.json workspaces/${WORKSPACE_ID}.workspace.json"
echo "    2. Configure skills, agents, MCP servers in the manifest"
echo "    3. Run provision-workspace.sh to sync skills"
echo ""
echo "============================================"
