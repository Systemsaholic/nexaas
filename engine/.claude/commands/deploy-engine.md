# Deploy Engine

You are deploying or updating the AI Mission Control engine service. This assumes a Linux server with systemd.

## Step 1: Environment Check

Check if systemd is available:
```bash
systemctl --version
```

If not available, inform the user this command requires a systemd-based Linux server and suggest alternative deployment options (Docker, manual process management).

Also check:
- Python 3.11+ is installed
- Node.js 22+ is installed (for Claude Code CLI)
- The current workspace has a valid `workspace.yaml`
- Identify the engine source directory (the `engine/` directory in the ai-mission-control repo)

Ask the user to confirm the deployment target directory (default: `/opt/mission-control/engine`).

## Step 2: Copy Engine Files

```bash
sudo mkdir -p /opt/mission-control/engine
sudo cp -r {engine_source}/* /opt/mission-control/engine/
sudo cp {workspace_root}/workspace.yaml /opt/mission-control/engine/
```

Ensure the workspace database path is correctly referenced. Ask the user for the workspace root path on the server if different from local.

## Step 3: Create/Update Virtual Environment

```bash
cd /opt/mission-control/engine
sudo python3 -m venv .venv
sudo ./.venv/bin/pip install --upgrade pip
sudo ./.venv/bin/pip install -r requirements.txt
```

## Step 4: Install Claude Code CLI

```bash
sudo npm install -g @anthropic-ai/claude-code
claude login
```

## Step 5: Run Database Migrations

Check if the database exists at the expected path. If not, initialize it.

If it exists, check for and apply any pending migrations:
```bash
./.venv/bin/python -c "from db import run_migrations; run_migrations()"
```

## Step 6: Configure Environment

Create or update `/opt/mission-control/engine/.env`:
```
WORKSPACE_ROOT={workspace_root_on_server}
DATABASE_PATH={workspace_root_on_server}/data/mission_control.db
HOST=0.0.0.0
PORT=8400
JWT_SECRET={generate_a_random_secret}
API_KEY={generate_a_random_key}
```

Ask the user:
- Which port to use (default: 8400)
- Whether to bind to all interfaces or localhost only
- Any additional environment variables needed

## Step 7: Install/Update systemd Service

```bash
sudo cp engine.service /etc/systemd/system/engine.service
sudo systemctl daemon-reload
sudo systemctl enable engine
```

## Step 8: Start/Restart Service

```bash
sudo systemctl restart engine
```

Wait a few seconds, then verify:
```bash
sudo systemctl status engine
```

## Step 9: Verify Health

```bash
curl -s http://localhost:8400/api/health
```

Expected response should indicate the service is healthy. If not, check logs:
```bash
sudo journalctl -u engine -n 50 --no-pager
```

## Completion

Summarize:
- Deployment path
- Service status
- Port and bind address
- Health check result
- How to view logs: `sudo journalctl -u engine -f`
- How to restart: `sudo systemctl restart engine`
- Register at: `http://<server>:3000/register`
