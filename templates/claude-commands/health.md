Run a full health check on this instance.

Check and report:

1. **System resources:**
   - `free -h` (RAM usage)
   - `df -h /` (disk usage)
   - `uptime` (load average)

2. **Docker containers:**
   - `docker ps --format 'table {{.Names}}\t{{.Status}}'`
   - Flag any containers not running or unhealthy

3. **Trigger.dev worker:**
   - `systemctl status nexaas-worker --no-pager`
   - If down, offer to restart: `sudo systemctl restart nexaas-worker`

4. **Recent errors:**
   - `journalctl -u nexaas-worker --no-pager -n 50 --since '1 hour ago' | grep -i error`

5. **Skills status:**
   - Read `/opt/nexaas/skills/_registry.yaml` for deployed skills
   - Check config exists for each: `ls /opt/nexaas/config/`

6. **Network connectivity:**
   - `ping -c 1 10.10.0.10` (orchestrator reachable?)

Present a clear summary with green/yellow/red indicators. If anything is wrong, explain what and offer to fix it.
