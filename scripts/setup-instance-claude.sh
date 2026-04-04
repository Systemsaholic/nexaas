#!/bin/bash
# Setup Claude Code on a Nexaas instance
# Usage: ./scripts/setup-instance-claude.sh <workspace-id> <vps-ip>
set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> <vps-ip>}"
VPS_IP="${2:?Usage: $0 <workspace-id> <vps-ip>}"
NEXAAS_ROOT="/opt/nexaas"
SSH_TARGET="ubuntu@${VPS_IP}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

# Load workspace manifest for name and network info
MANIFEST="${NEXAAS_ROOT}/workspaces/${WORKSPACE_ID}.workspace.json"
if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Manifest not found: $MANIFEST"
  exit 1
fi

WORKSPACE_NAME=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['name'])")
PRIVATE_IP=$(python3 -c "import json; print(json.load(open('${MANIFEST}'))['network']['privateIp'])")

echo "Setting up Claude Code for ${WORKSPACE_NAME} (${WORKSPACE_ID}) on ${VPS_IP}"

# 1. Install Claude Code if not present
ssh ${SSH_OPTS} ${SSH_TARGET} "command -v claude >/dev/null 2>&1 || (curl -fsSL https://claude.ai/install.sh | sh)"

# 2. Generate CLAUDE.md from template
TEMPLATE="${NEXAAS_ROOT}/templates/instance-CLAUDE.md"
CLAUDE_MD=$(sed \
  -e "s/{{WORKSPACE_ID}}/${WORKSPACE_ID}/g" \
  -e "s/{{WORKSPACE_NAME}}/${WORKSPACE_NAME}/g" \
  -e "s/{{PRIVATE_IP}}/${PRIVATE_IP}/g" \
  "$TEMPLATE")

# 3. Write CLAUDE.md to instance
ssh ${SSH_OPTS} ${SSH_TARGET} "cat > ${NEXAAS_ROOT}/CLAUDE.md << 'CLAUDEEOF'
${CLAUDE_MD}
CLAUDEEOF"

echo "CLAUDE.md installed on ${WORKSPACE_ID}"

# 4. Ensure .claude directory exists and deploy slash commands
ssh ${SSH_OPTS} ${SSH_TARGET} "mkdir -p ${NEXAAS_ROOT}/.claude/commands"

# 5. Sync slash commands from orchestrator templates
rsync -av --delete \
  ${NEXAAS_ROOT}/templates/claude-commands/ \
  ${SSH_TARGET}:${NEXAAS_ROOT}/.claude/commands/

echo "Slash commands installed on ${WORKSPACE_ID}"
echo "Claude Code setup complete for ${WORKSPACE_ID}"
