#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Nexaas Engine Installer ==="

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
echo "Installing Python dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

# Create data directory and initialize database
echo "Initializing database..."
mkdir -p data
python3 -c "
import asyncio
import sys
sys.path.insert(0, '.')
from db.database import init_db, close_db
async def main():
    await init_db()
    await close_db()
    print('Database initialized.')
asyncio.run(main())
"

# Install Node.js if not present (needed for Claude Code)
if ! command -v node &>/dev/null; then
    echo "Installing Node.js..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
        sudo apt-get install -y nodejs
    else
        echo "Node.js not found. Please install Node.js 22+ manually."
    fi
fi

# Install Claude Code CLI
if ! command -v claude &>/dev/null; then
    echo "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
fi

# Claude Code authentication
echo ""
read -rp "Authenticate Claude Code now? [y/N] " auth_claude
if [[ "$auth_claude" =~ ^[Yy] ]]; then
    claude login
fi

# Install systemd service if running as root or with sudo
if [ "$(id -u)" -eq 0 ] || command -v sudo &>/dev/null; then
    echo "Installing systemd service..."
    SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
        SUDO="sudo"
    fi
    $SUDO cp engine.service /etc/systemd/system/engine.service
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable engine
    $SUDO systemctl start engine
    echo "Service installed and started."
else
    echo "Skipping systemd install (no root/sudo). Run manually:"
    echo "  source .venv/bin/activate && python server.py"
fi

# Health check
echo ""
echo "Running health check..."
sleep 2
if curl -sf http://localhost:8400/api/health &>/dev/null; then
    echo "Engine is healthy!"
else
    echo "Engine health check failed. Check logs for details."
fi

echo "=== Installation complete ==="
