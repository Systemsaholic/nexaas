#!/bin/sh
set -e

echo "Nexaas Orchestrator — Custom Trigger.dev entrypoint"

# Run Prisma migrations
echo "Running prisma migrations..."
cd /triggerdotdev
pnpm --filter @trigger.dev/database db:migrate:deploy
echo "Prisma migrations done"

# Run ClickHouse migrations via goose
if [ -n "$CLICKHOUSE_URL" ]; then
  echo "Running ClickHouse migrations..."
  export GOOSE_DRIVER=clickhouse
  GOOSE_BASE=$(echo "$CLICKHOUSE_URL" | sed 's/?.*$//')
  export GOOSE_DBSTRING="${GOOSE_BASE}?secure=false"
  export GOOSE_MIGRATION_DIR=/triggerdotdev/internal-packages/clickhouse/schema
  /usr/local/bin/goose up || echo "ClickHouse goose migration warning (non-fatal): $?"
  echo "ClickHouse migrations step done"
fi

# Prepare webapp
cp internal-packages/database/prisma/schema.prisma apps/webapp/prisma/
cp node_modules/@prisma/engines/libquery_engine-debian-openssl-1.1.x.so.node apps/webapp/prisma/

# Start webapp
cd /triggerdotdev/apps/webapp
MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-1600}"
echo "Setting max old space size to $MAX_OLD_SPACE_SIZE"
NODE_PATH=/triggerdotdev/node_modules/.pnpm/node_modules exec dumb-init node --max-old-space-size=$MAX_OLD_SPACE_SIZE ./build/server.js
