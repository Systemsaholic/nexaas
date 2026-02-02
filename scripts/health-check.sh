#!/usr/bin/env bash
set -euo pipefail

ERRORS=0
DOCKER_MODE=false
ENGINE_URL="http://localhost:8400"

for arg in "$@"; do
  case $arg in
    --docker) DOCKER_MODE=true ;;
  esac
done

check() {
  local name="$1"
  local cmd="$2"
  printf "%-40s" "Checking $name..."
  if eval "$cmd" &>/dev/null; then
    echo "OK"
  else
    echo "FAIL"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "=== Nexaas Health Check ==="
echo ""

# Engine health
check "Engine /api/health" "curl -sf ${ENGINE_URL}/api/health"

# Database access (via engine)
check "Database (via health)" "curl -sf ${ENGINE_URL}/api/health | grep -q ok"

if [ "$DOCKER_MODE" = true ]; then
  # Docker-specific checks
  check "Engine container" "docker compose ps engine --format json | grep -q running"
  check "Dashboard container" "docker compose ps dashboard --format json | grep -q running"
  check "Dashboard reachable" "curl -sf http://localhost:3000 -o /dev/null -w '%{http_code}' | grep -qE '200|302'"
else
  # Local checks
  check "Claude Code CLI" "command -v claude"
  check "Dashboard reachable" "curl -sf http://localhost:3000 -o /dev/null -w '%{http_code}' | grep -qE '200|302'"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "All checks passed."
else
  echo "$ERRORS check(s) failed."
fi

exit $ERRORS
