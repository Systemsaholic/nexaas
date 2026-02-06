# Health Check

Quick health check of all services.

## Detect Deployment Type

```bash
# Check deployment type
if docker compose ps 2>/dev/null | grep -q "engine"; then
  DEPLOY_TYPE="docker"
elif systemctl is-active nexaas-engine 2>/dev/null; then
  DEPLOY_TYPE="systemd"
else
  DEPLOY_TYPE="local"
fi
```

## Run Checks

### 1. Engine Health

```bash
curl -s http://localhost:8400/api/health
```

Expected: `{"status": "ok", ...}`

### 2. Dashboard

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
```

Expected: `200`

### 3. Database

**Docker:**
```bash
docker compose exec engine sqlite3 /data/nexaas.db "SELECT COUNT(*) FROM events;"
```

**Local/Systemd:**
```bash
sqlite3 data/nexaas.db "SELECT COUNT(*) FROM events;"
```

Expected: Returns a number (no error)

### 4. Workers

```bash
curl -s -H "Authorization: Bearer $API_KEY" localhost:8400/api/queue | jq '.workers'
```

Expected: Shows worker status

### 5. Services Running

**Docker:**
```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

**Systemd:**
```bash
systemctl status nexaas-engine nexaas-dashboard --no-pager
```

**Local:**
```bash
pgrep -fa "server.py|next"
```

## Report

```
========================================
  Health Check
========================================

Deployment: {docker/systemd/local}
Engine:     ✓ healthy
Dashboard:  ✓ responding
Database:   ✓ connected ({n} events)
Workers:    ✓ {n}/{n} active

All systems operational.
========================================
```

Or if issues:

```
========================================
  Health Check
========================================

Deployment: {docker/systemd/local}
Engine:     ✓ healthy
Dashboard:  ✗ not responding
Database:   ✓ connected
Workers:    ✓ 3/3 active

Issues detected:
1. Dashboard not responding

   Docker:   docker compose logs dashboard
   Systemd:  journalctl -u nexaas-dashboard -n 50
   Local:    Check if process is running

   Restart:
   Docker:   docker compose restart dashboard
   Systemd:  sudo systemctl restart nexaas-dashboard
   Local:    cd dashboard && npm run dev
========================================
```

## Detailed Diagnostics

If issues found, offer:
- View logs for failing service (deployment-appropriate command)
- Restart failing service (deployment-appropriate command)
- Check environment variables
- Check disk space: `df -h`
- Check memory: `free -m`
