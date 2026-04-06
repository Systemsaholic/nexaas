#!/bin/bash
# Integrity DB check — run on instance via SSH
# Outputs: workspace_skills_count|channel_count|table_count
source /opt/nexaas/.env 2>/dev/null
WS="$1"

SKILLS=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM workspace_skills WHERE workspace_id = '$WS' AND active = true" 2>/dev/null || echo 0)
CHANNELS=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM channel_registry WHERE workspace_id = '$WS' AND active = true" 2>/dev/null || echo 0)
TABLES=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0)
CONFIG=$(test -f /opt/nexaas/config/client-profile.yaml && echo 1 || echo 0)

echo "${SKILLS}|${CHANNELS}|${TABLES}|${CONFIG}"
