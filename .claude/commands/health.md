# Health Check

Quick health check of all services.

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

```bash
docker compose exec engine sqlite3 /data/nexaas.db "SELECT COUNT(*) FROM events;"
```

Expected: Returns a number (no error)

### 4. Workers

```bash
curl -s -H "Authorization: Bearer $API_KEY" localhost:8400/api/queue | jq '.workers'
```

Expected: Shows worker status

### 5. Docker Containers

```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

Expected: All containers "Up"

## Report

```
========================================
  Health Check
========================================

Engine:     ✓ healthy
Dashboard:  ✓ responding
Database:   ✓ connected ({n} events)
Workers:    ✓ {n}/{n} active
Containers: ✓ all running

All systems operational.
========================================
```

Or if issues:

```
========================================
  Health Check
========================================

Engine:     ✓ healthy
Dashboard:  ✗ not responding
Database:   ✓ connected
Workers:    ✓ 3/3 active
Containers: ✗ dashboard exited

Issues detected:
1. Dashboard not responding
   → Check logs: docker compose logs dashboard
   → Restart: docker compose restart dashboard
========================================
```

## Detailed Diagnostics

If issues found, offer:
- View logs for failing service
- Restart failing service
- Check environment variables
- Check disk space
