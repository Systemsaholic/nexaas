#!/usr/bin/env bash
# Wrapper script for Trigger.dev dev worker
# Ensures proper stdout/stderr handling for systemd journald
set -euo pipefail

# Default to repo root, override with TRIGGER_DIR env var
TRIGGER_DIR="${TRIGGER_DIR:-$(dirname "$0")/..}"
cd "$TRIGGER_DIR"

# Source environment if .env exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"

# Ensure Claude nesting detection is cleared
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

# Suppress interactive prompts under systemd
export CI=true

# Cap concurrent runs to prevent memory spikes from parallel Claude Code processes
# Each Claude CLI: ~1.2-1.6 GB. Tune MAX_CONCURRENT based on VPS RAM.
MAX_CONCURRENT="${MAX_CONCURRENT_RUNS:-5}"

exec ./node_modules/.bin/trigger dev \
  --skip-update-check \
  --max-concurrent-runs "$MAX_CONCURRENT" \
  --log-level log \
  2>&1
