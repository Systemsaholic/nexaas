#!/bin/bash
# Instance health collection script — run by orchestrator via SSH
# Output: 5 sections separated by "---"
free -m | awk '/^Mem:/ {print $2,$3}'
echo "---"
df -BG / | awk 'NR==2 {gsub(/G/,""); print $2,$3}'
echo "---"
docker ps --format '{{.Names}}' 2>/dev/null | wc -l
echo "---"
docker ps --format '{{.Status}}' 2>/dev/null | grep -v '(unhealthy)' | grep -c Up || echo 0
echo "---"
systemctl is-active nexaas-worker 2>/dev/null || echo inactive
