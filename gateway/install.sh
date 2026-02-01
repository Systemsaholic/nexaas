#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== AI Mission Control Gateway Installer ==="

# Create virtual environment
echo "Creating virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
echo "Installing dependencies..."
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

# Install systemd service if running as root or with sudo
if [ "$(id -u)" -eq 0 ] || command -v sudo &>/dev/null; then
    echo "Installing systemd service..."
    SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
        SUDO="sudo"
    fi
    $SUDO cp gateway.service /etc/systemd/system/gateway.service
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable gateway
    $SUDO systemctl start gateway
    echo "Service installed and started."
else
    echo "Skipping systemd install (no root/sudo). Run manually:"
    echo "  source .venv/bin/activate && python server.py"
fi

echo "=== Installation complete ==="
