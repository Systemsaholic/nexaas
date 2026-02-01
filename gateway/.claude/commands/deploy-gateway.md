# Deploy Gateway

You are deploying or updating the AI Mission Control gateway service. This assumes a Linux server with systemd.

## Step 1: Environment Check

Check if systemd is available:
```bash
systemctl --version
```

If not available, inform the user this command requires a systemd-based Linux server and suggest alternative deployment options (Docker, manual process management).

Also check:
- Python 3.11+ is installed
- The current workspace has a valid `workspace.yaml`
- Identify the gateway source directory (the `gateway/` directory in the ai-mission-control repo)

Ask the user to confirm the deployment target directory (default: `/opt/mission-control/gateway`).

## Step 2: Copy Gateway Files

```bash
sudo mkdir -p /opt/mission-control/gateway
sudo cp -r {gateway_source}/* /opt/mission-control/gateway/
sudo cp {workspace_root}/workspace.yaml /opt/mission-control/gateway/
```

Ensure the workspace database path is correctly referenced. Ask the user for the workspace root path on the server if different from local.

## Step 3: Create/Update Virtual Environment

```bash
cd /opt/mission-control/gateway
sudo python3 -m venv venv
sudo ./venv/bin/pip install --upgrade pip
sudo ./venv/bin/pip install -r requirements.txt
```

If `requirements.txt` doesn't exist, check for `pyproject.toml` and install accordingly.

## Step 4: Run Database Migrations

Check if the database exists at the expected path. If not, initialize it using the schema from `init-workspace.md`.

If it exists, check for and apply any pending migrations:
```bash
./venv/bin/python -c "from db import run_migrations; run_migrations()"
```

Or if migrations are SQL files, apply them in order.

## Step 5: Configure Environment

Create or update `/opt/mission-control/gateway/.env`:
```
WORKSPACE_ROOT={workspace_root_on_server}
DATABASE_PATH={workspace_root_on_server}/data/mission_control.db
HOST=0.0.0.0
PORT=8080
LOG_LEVEL=info
```

Ask the user:
- Which port to use (default: 8080)
- Whether to bind to all interfaces or localhost only
- Any additional environment variables needed

## Step 6: Install/Update systemd Service

Create or update `/etc/systemd/system/mission-control.service`:

```ini
[Unit]
Description=AI Mission Control Gateway
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/mission-control/gateway
Environment=PATH=/opt/mission-control/gateway/venv/bin:/usr/bin
EnvironmentFile=/opt/mission-control/gateway/.env
ExecStart=/opt/mission-control/gateway/venv/bin/python -m uvicorn main:app --host ${HOST} --port ${PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Then reload and enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable mission-control
```

## Step 7: Start/Restart Service

Check current service status:
```bash
sudo systemctl status mission-control
```

If running, restart:
```bash
sudo systemctl restart mission-control
```

If not running, start:
```bash
sudo systemctl start mission-control
```

Wait a few seconds, then verify:
```bash
sudo systemctl status mission-control
```

## Step 8: Verify Health

Check the health endpoint:
```bash
curl -s http://localhost:8080/health
```

Expected response should indicate the service is healthy. If not, check logs:
```bash
sudo journalctl -u mission-control -n 50 --no-pager
```

Show relevant log output to the user and help troubleshoot if needed.

## Completion

Summarize:
- Deployment path
- Service status
- Port and bind address
- Health check result
- How to view logs: `sudo journalctl -u mission-control -f`
- How to restart: `sudo systemctl restart mission-control`
