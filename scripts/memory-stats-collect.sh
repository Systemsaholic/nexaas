#!/bin/bash
# Memory stats collection — run by the Nexmatic ops-console via SSH on client VPS.
# Queries nexaas_memory.* tables and outputs sections separated by "---".
#
# Output order:
#   1. event_count
#   2. entity_count
#   3. active_fact_count
#   4. relation_count
#   5. active_journal_entries
#   6. embedding_lag
#   7. events_24h
#   8. event_type_breakdown (JSON)
#   9. oldest_event (ISO or empty)
#  10. newest_event (ISO or empty)
#
# If nexaas_memory schema does not exist, outputs zeros so the collector
# records a snapshot showing memory system is not yet deployed.

DB="${DATABASE_URL:-postgresql://postgres@localhost/nexaas}"

psql_q() {
  psql "$DB" -t -A -c "$1" 2>/dev/null || echo "0"
}

# Schema check — exit early with zeros if not deployed
SCHEMA_EXISTS=$(psql "$DB" -t -A -c "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'nexaas_memory'" 2>/dev/null)

if [ -z "$SCHEMA_EXISTS" ]; then
  echo "0"
  for i in 1 2 3 4 5 6; do echo "---"; echo "0"; done
  echo "---"
  echo "{}"
  echo "---"
  echo ""
  echo "---"
  echo ""
  exit 0
fi

psql_q "SELECT COUNT(*) FROM nexaas_memory.events"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.entities"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.facts WHERE superseded_by IS NULL"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.relations"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.agent_journal WHERE flushed_at IS NULL"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.events WHERE embedding_id IS NULL"
echo "---"
psql_q "SELECT COUNT(*) FROM nexaas_memory.events WHERE created_at > NOW() - INTERVAL '24 hours'"
echo "---"
psql "$DB" -t -A -c "SELECT COALESCE(jsonb_object_agg(event_type, cnt)::text, '{}') FROM (SELECT event_type, COUNT(*)::int AS cnt FROM nexaas_memory.events GROUP BY event_type) t" 2>/dev/null || echo "{}"
echo "---"
psql_q "SELECT COALESCE(MIN(created_at)::text, '') FROM nexaas_memory.events"
echo "---"
psql_q "SELECT COALESCE(MAX(created_at)::text, '') FROM nexaas_memory.events"
