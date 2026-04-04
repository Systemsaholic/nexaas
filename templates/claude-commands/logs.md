Show recent worker logs and help diagnose issues.

Optional filter argument: $ARGUMENTS (e.g., "errors", "skill-name", "last hour")

1. If argument is "errors" or empty, show errors:
   `journalctl -u nexaas-worker --no-pager -n 100 --since '4 hours ago' | grep -i -E 'error|fail|warn'`

2. If argument is a skill name, filter for that skill:
   `journalctl -u nexaas-worker --no-pager -n 200 --since '24 hours ago' | grep -i '{skill-name}'`

3. Otherwise show recent logs:
   `journalctl -u nexaas-worker --no-pager -n 100`

4. Also check Docker container logs if relevant:
   `docker logs trigger-trigger-webapp-1 --tail 50 2>&1 | tail -20`

Summarize what you see — don't just dump raw logs. Identify patterns, recurring errors, and suggest fixes.
