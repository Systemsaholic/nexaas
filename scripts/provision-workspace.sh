#!/bin/bash
# scripts/provision-workspace.sh
# Provision a new client workspace on a dedicated VPS
# Usage: ./scripts/provision-workspace.sh [workspace-id] [vps-ip]

set -e

WORKSPACE_ID=$1
VPS_IP=$2
NEXAAS_ROOT="${NEXAAS_ROOT:-/opt/nexaas}"
WORKSPACE_ROOT="/opt/workspaces/${WORKSPACE_ID}"

if [ -z "$WORKSPACE_ID" ] || [ -z "$VPS_IP" ]; then
  echo "Usage: $0 [workspace-id] [vps-ip]"
  exit 1
fi

MANIFEST="${NEXAAS_ROOT}/workspaces/${WORKSPACE_ID}.workspace.json"
if [ ! -f "$MANIFEST" ]; then
  echo "Error: Workspace manifest not found at ${MANIFEST}"
  echo "Create it first: cp templates/workspace.workspace.json workspaces/${WORKSPACE_ID}.workspace.json"
  exit 1
fi

echo "Provisioning workspace: ${WORKSPACE_ID} on ${VPS_IP}"

# 1. Create workspace directory on client VPS
echo "Creating workspace directory..."
ssh root@${VPS_IP} "mkdir -p ${WORKSPACE_ROOT}"

# 2. Sync Nexaas skills (subscribed skills only)
echo "Syncing subscribed skills..."
SUBSCRIBED_SKILLS=$(cat "$MANIFEST" | python3 -c "
import json,sys
m = json.load(sys.stdin)
print('\n'.join(m.get('skills', [])))
")

ssh root@${VPS_IP} "mkdir -p /opt/nexaas/skills"
for SKILL in $SUBSCRIBED_SKILLS; do
  SKILL_PATH="${NEXAAS_ROOT}/skills/${SKILL}"
  DEST_PATH="/opt/nexaas/skills/${SKILL}"
  if [ -d "$SKILL_PATH" ]; then
    echo "  Syncing skill: ${SKILL}"
    rsync -av --delete "${SKILL_PATH}/" "root@${VPS_IP}:${DEST_PATH}/"
  else
    echo "  Skill not found: ${SKILL}"
  fi
done

# 3. Sync MCP configs
echo "Syncing MCP configs..."
rsync -av "${NEXAAS_ROOT}/mcp/configs/" "root@${VPS_IP}:/opt/nexaas/mcp/configs/"
rsync -av "${NEXAAS_ROOT}/mcp/_registry.yaml" "root@${VPS_IP}:/opt/nexaas/mcp/_registry.yaml"

# 4. Sync workspace manifest
echo "Syncing workspace manifest..."
rsync -av "$MANIFEST" "root@${VPS_IP}:/opt/nexaas/workspaces/${WORKSPACE_ID}.workspace.json"

# 5. Sync templates
echo "Syncing templates..."
rsync -av "${NEXAAS_ROOT}/templates/" "root@${VPS_IP}:/opt/nexaas/templates/"

# 6. Install Node.js and Trigger.dev worker on client VPS
echo "Installing Trigger.dev worker..."
ssh root@${VPS_IP} << 'ENDSSH'
  if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  npm install -g @trigger.dev/sdk
  mkdir -p /opt/trigger-worker
ENDSSH

# 7. Write systemd service for Trigger worker
echo "Configuring Trigger worker service..."
TRIGGER_PROJECT_ID=$(cat "$MANIFEST" | python3 -c "
import json,sys
m = json.load(sys.stdin)
print(m.get('trigger', {}).get('projectId', ''))
")

ssh root@${VPS_IP} "cat > /etc/systemd/system/nexaas-worker.service << EOF
[Unit]
Description=Nexaas Trigger.dev Worker - ${WORKSPACE_ID}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/trigger-worker
Environment=TRIGGER_API_URL=${TRIGGER_API_URL}
Environment=TRIGGER_PROJECT=${TRIGGER_PROJECT_ID}
Environment=TRIGGER_ACCESS_TOKEN=${TRIGGER_WORKER_TOKEN}
Environment=NEXAAS_WORKSPACE=${WORKSPACE_ID}
Environment=NEXAAS_ROOT=/opt/nexaas
Environment=NEXAAS_WORKSPACE_ROOT=${WORKSPACE_ROOT}
Environment=ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
ExecStart=/usr/bin/npx trigger.dev@latest worker
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF"

ssh root@${VPS_IP} "systemctl daemon-reload && systemctl enable nexaas-worker && systemctl start nexaas-worker"

echo "Workspace ${WORKSPACE_ID} provisioned successfully on ${VPS_IP}"
echo ""
echo "Next steps:"
echo "  1. Configure MCP server env vars on ${VPS_IP}"
echo "  2. Verify worker registered: check Trigger.dev dashboard -> Workers"
echo "  3. Run test task: npx trigger.dev@latest trigger run-skill --payload '{\"skillId\":\"msp/health-check\",\"workspaceId\":\"${WORKSPACE_ID}\",\"prompt\":\"Run health check\",\"source\":\"manual\"}'"
