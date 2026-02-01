#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== AI Mission Control — Deploy ==="
echo ""

# 1. Check prerequisites
for cmd in docker "docker compose"; do
  if ! command -v ${cmd%% *} &>/dev/null; then
    echo "Error: $cmd is required but not installed."
    exit 1
  fi
done
echo "Prerequisites OK (docker, docker compose)"

# 2. Generate .env if missing
if [ ! -f .env ]; then
  API_KEY="${API_KEY:-$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')}"
  JWT_SECRET="${JWT_SECRET:-$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')}"
  cat > .env <<EOF
API_KEY=${API_KEY}
JWT_SECRET=${JWT_SECRET}
NEXT_PUBLIC_DEFAULT_GATEWAY_URL=http://engine:8400
DEFAULT_GATEWAY_KEY=${API_KEY}
EOF
  echo "Generated .env (API_KEY=${API_KEY:0:8}...)"
else
  echo "Using existing .env"
  # Source it so we have API_KEY for summary
  set -a; source .env; set +a
fi

# 3. Build
echo ""
echo "Building containers..."
docker compose build

# 4. Start
echo "Starting services..."
docker compose up -d

# 5. Wait for engine health
echo -n "Waiting for engine"
for i in $(seq 1 30); do
  if curl -sf http://localhost:8400/api/health &>/dev/null; then
    echo " ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo " timeout!"
    echo "Engine failed to start. Check logs: docker compose logs engine"
    exit 1
  fi
  echo -n "."
  sleep 1
done

# 6. Claude Code authentication (optional)
echo ""
read -rp "Authenticate Claude Code in engine container? [y/N] " auth_claude
if [[ "$auth_claude" =~ ^[Yy] ]]; then
  docker compose exec -it engine claude login
fi

# 7. Seed demo data (optional)
if [ -f engine/seed-demo.py ]; then
  read -rp "Seed demo data? [y/N] " seed
  if [[ "$seed" =~ ^[Yy] ]]; then
    docker compose exec engine python seed-demo.py
  fi
fi

# 8. Health check
echo ""
bash scripts/health-check.sh --docker || true

# 9. Summary
echo ""
echo "========================================="
echo "  AI Mission Control is running!"
echo "========================================="
echo ""
echo "  Engine:    http://localhost:8400"
echo "  Dashboard: http://localhost:3000"
echo ""
echo "  Register:  http://localhost:3000/register"
echo ""
echo "  Logs:      docker compose logs -f"
echo "  Stop:      docker compose down"
echo "========================================="
